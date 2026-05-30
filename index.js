const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर एक्टिव रखने के लिए
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Dual Sheets Hindi System Active'); });
server.listen(port);

// गूगल शीट क्रेडेंशियल सेटअप
const privateKey = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6NfW9i6bV/E6j\n9T67Xf0gKmdH9mB6B+6eD1N2e4vYpCq0vJb4hXh6Hl7iK8x9wXn+Z1P9mC5v5mK8\n-----END PRIVATE KEY-----\n`;
const auth = new google.auth.JWT(
  'telegram-bot-service@mystic-vessel-421711.iam.gserviceaccount.com',
  null,
  privateKey.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

let globalOrderNum = 100;

// --- रोजाना रात 12 बजे ऑर्डर आईडी ऑटो-रीसेट लॉजिक ---
function startDailyResetTimer() {
  setInterval(() => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (globalOrderNum !== 100) {
        globalOrderNum = 100;
        console.log("Order ID successfully reset to 100 for the new day!");
      }
    }
  }, 60000); // बैकग्राउंड में हर मिनट चेक करेगा
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

const adminToResellerMsgMap = new Map();

// --- दोनों शीट्स (Master_Sheet और Order_Count) में डेटा सेव करने का फंक्शन ---
async function saveToDualSheets(orderNum, reseller, userId, cleanAddress) {
  try {
    const pDate = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const shortDate = pDate.split(',')[0]; // सिर्फ तारीख (MM/DD/YYYY) निकालने के लिए

    // 1. Master_Sheet में सिर्फ 'क्लीन एड्रेस' सेव करना (Column A में)
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Master_Sheet!A:A',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[cleanAddress]] }
    });

    // 2. Order_Count में रिसेलर का डेली रेकॉर्ड चेक और अपडेट करना
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Order_Count!A:C',
    });

    const rows = res.data.values || [];
    let foundRowIndex = -1;

    // चेक करें कि क्या आज की तारीख में इस रिसेलर की लाइन पहले से है?
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === shortDate && rows[i][1] === `${reseller} (${userId})`) {
        foundRowIndex = i + 1; // शीट की रो इंडेक्स 1 से शुरू होती है
        break;
      }
    }

    if (foundRowIndex !== -1) {
      // अगर पहले से एंट्री है, तो टोटल ऑर्डर्स काउंट +1 बढ़ाएं
      const currentOrders = parseInt(rows[foundRowIndex - 1][2] || '0');
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `Order_Count!C${foundRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[currentOrders + 1]] }
      });
    } else {
      // अगर आज का पहला ऑर्डर है, तो नई लाइन जोड़ें (Date, Reseller with ID, Total Orders = 1)
      await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'Order_Count!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[shortDate, `${reseller} (${userId})`, 1]] }
      });
    }

  } catch (err) { 
    console.error("Google Sheets Sync Error:", err.message); 
  }
}

// कतार इंजन (15 सेकंड का लॉक)
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); 
  const { userId, resellerName, items } = userTask;

  let mainAddressItem = null;
  let assignedOrderNum = null;

  // 1. असली बड़े एड्रेस की पहचान करना
  for (const item of items) {
    if (item.type === 'text') {
      const txt = item.text.trim();
      if (txt.length > 30 && /\b\d{6}\b/.test(txt) && /\b\d{10,12}\b/.test(txt)) {
        mainAddressItem = item;
        item.isRealAddress = true;
        break;
      }
    }
  }

  if (mainAddressItem) {
    globalOrderNum++;
    assignedOrderNum = globalOrderNum;
  }

  // 2. छोटे स्टिकर्स हटाना और सॉर्टिंग करना
  let filteredItems = items.filter(item => {
    if (item.type === 'text' && !item.isRealAddress) {
      if (item.text.length < 10) return false;
    }
    return true;
  });

  filteredItems.sort((a, b) => {
    if (a.isRealAddress) return -1;
    if (b.isRealAddress) return 1;
    if (a.type === 'photo' && b.type !== 'photo') return -1;
    if (a.type !== 'photo' && b.type === 'photo') return 1;
    return 0;
  });

  // 3. ग्रुप में सिस्टिमैटिक डिलीवरी करना
  for (const item of filteredItems) {
    try {
      let sentMsg = null;

      if (item.type === 'photo') {
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (item.text !== "") {
          caption += `\n\n📝 विवरण: ${item.text}`;
        }
        sentMsg = await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption });
      } 
      else if (item.type === 'text' && item.isRealAddress) {
        let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #ORD${assignedOrderNum}*\n\n${item.text}`;
        sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
        
        // यहाँ शीट में सिर्फ रिसेलर का भेजा हुआ क्लीन एड्रेस ही जाएगा
        await saveToDualSheets(assignedOrderNum, resellerName, userId, item.text);
      }
      else if (item.type === 'text') {
        sentMsg = await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n📝: ${item.text}`);
      }

      if (sentMsg && item.originalMsgId) {
        adminToResellerMsgMap.set(sentMsg.message_id.toString(), item.originalMsgId);
      }
    } catch (e) {
      console.error("Group Delivery Error:", e.message);
    }
  }

  // 4. ऑटोमैटिक Next Order डिवाइडर मैसेज (हमेशा अंत में)
  if (mainAddressItem) {
    try {
      await bot.sendMessage(adminGroupId, `🟢 *Next Order* 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Divider Error:", e.message); }
  }

  setTimeout(processGlobalUserQueue, 15000);
}

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();

  // --- नियम 1: एडमीन ग्रुप से रिसेलर को सीधा सटीक रिप्लाई जाना ---
  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      const adminRepliedMsgId = msg.reply_to_message.message_id.toString();
      const originalResellerMsgId = adminToResellerMsgMap.get(adminRepliedMsgId);
      
      let replyOptions = {};
      if (originalResellerMsgId) {
        replyOptions.reply_to_message_id = parseInt(originalResellerMsgId);
      }

      if (msg.photo) {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText, replyOptions);
        return;
      }
    }
    return;
  }

  // --- नियम 2: कतार कलेक्शन (25 सेकंड का होल्ड टाइमर) ---
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [] };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, originalMsgId: msg.message_id, isRealAddress: false });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id, isRealAddress: false });
    }

    currentSession.timeoutId = setTimeout(() => {
      const sessionToSend = userSessions.get(chatId);
      if (sessionToSend && sessionToSend.messages.length > 0) {
        globalUserQueue.push({
          userId: sessionToSend.userId,
          resellerName: sessionToSend.resellerName,
          items: [...sessionToSend.messages]
        });
        userSessions.delete(chatId);

        if (!isProcessingQueue) {
          processGlobalUserQueue();
        }
      }
    }, 25000);
  }
});
