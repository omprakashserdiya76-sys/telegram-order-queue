const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

// रेंडर के Environment Variables से नई चाबी उठाना
const rawKey = process.env.GOOGLE_PRIVATE_KEY || "";
const privateKey = rawKey.replace(/\\n/g, '\n');

const bot = new TelegramBot(token, { polling: true });

// वेब सर्वर एक्टिव रखने के लिए रेंडर पोर्ट कस्टमाइज़ेशन
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Dual Sheets System Fully Active'); });
server.listen(port);

// गूगल शीट क्रेडेंशियल सेटअप (नया प्रोजेक्ट आईडी क्रेडेंशियल जो आपने भेजा)
const auth = new google.auth.JWT(
  'order-bot@default-gemini-project-485218.iam.gserviceaccount.com',
  null,
  privateKey,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

let globalOrderNum = 100;

// --- रोजाना रात 12 बजे आईडी रीसेट लॉजिक ---
function startDailyResetTimer() {
  setInterval(() => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (globalOrderNum !== 100) {
        globalOrderNum = 100;
        console.log("Order ID Reset Done!");
      }
    }
  }, 60000);
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

const adminToResellerMsgMap = new Map();

// --- दोनों शीट्स में क्लीन डेटा भेजने का फंक्शन ---
async function saveToDualSheets(orderNum, reseller, userId, cleanAddress) {
  try {
    const pDate = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const shortDate = pDate.split(',')[0]; 

    // 1. Master_Sheet में सिर्फ क्लीन एड्रेस डालना
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Master_Sheet!A:A',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[cleanAddress]] }
    });
    console.log("-> Master_Sheet Successfully Updated!");

    // 2. Order_Count में गिनती बढ़ाना या नई लाइन जोड़ना
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Order_Count!A:C',
    });

    const rows = res.data.values || [];
    let foundRowIndex = -1;
    const searchTarget = `${reseller} (${userId})`;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === shortDate && rows[i][1] === searchTarget) {
        foundRowIndex = i + 1;
        break;
      }
    }

    if (foundRowIndex !== -1) {
      const currentOrders = parseInt(rows[foundRowIndex - 1][2] || '0');
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `Order_Count!C${foundRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[currentOrders + 1]] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'Order_Count!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[shortDate, searchTarget, 1]] }
      });
    }
    console.log("-> Order_Count Successfully Updated!");

  } catch (err) { 
    console.error("Google Sheets Write Error:", err.message); 
  }
}

// कतार इंजन (15 सेकंड गैप लॉक)
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

  for (const item of filteredItems) {
    try {
      let sentMsg = null;

      if (item.type === 'photo') {
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (item.text !== "") caption += `\n\n📝 विवरण: ${item.text}`;
        sentMsg = await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption });
      } 
      else if (item.type === 'text' && item.isRealAddress) {
        let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #ORD${assignedOrderNum}*\n\n${item.text}`;
        sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
        
        await saveToDualSheets(assignedOrderNum, resellerName, userId, item.text);
      }
      else if (item.type === 'text') {
        sentMsg = await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n📝: ${item.text}`);
      }

      if (sentMsg && item.originalMsgId) {
        adminToResellerMsgMap.set(sentMsg.message_id.toString(), item.originalMsgId);
      }
    } catch (e) { console.error("Delivery Error:", e.message); }
  }

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

  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      const adminRepliedMsgId = msg.reply_to_message.message_id.toString();
      const originalResellerMsgId = adminToResellerMsgMap.get(adminRepliedMsgId);
      
      let replyOptions = {};
      if (originalResellerMsgId) replyOptions.reply_to_message_id = parseInt(originalResellerMsgId);

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
        if (!isProcessingQueue) processGlobalUserQueue();
      }
    }, 25000);
  }
});
