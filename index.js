const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को एक्टिव रखने के लिए सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Perfect System Live'); });
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

// रिसेलर्स कतार डेटाबेस
const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

// एडमिन ग्रुप के मैसेज की ओरिजिनल रिसेलर मैसेज ID ट्रैक करने के लिए मैप
const adminToResellerMsgMap = new Map();

async function saveToSheet(orderNum, reseller, userId, address) {
  try {
    const pDate = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Sheet1!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[pDate, `#ORD${orderNum}`, reseller, userId, address]] }
    });
  } catch (err) { console.error("Sheet Error:", err.message); }
}

// पैकेट्स को 15-15 सेकंड के अंतर पर एडमीन ग्रुप में भेजने वाला इंजन
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); 
  const { userId, resellerName, items } = userTask;

  // शुद्ध एड्रेस की पहचान
  let combinedText = items.map(i => i.text).join("\n").trim();
  const isLongEnough = combinedText.length > 30;
  const hasPin = /\b\d{6}\b/.test(combinedText);
  const hasPhone = /\b\d{10,12}\b/.test(combinedText);
  const isRealOrder = isLongEnough && hasPin && hasPhone;

  let assignedOrderNum = null;
  if (isRealOrder) {
    globalOrderNum++;
    assignedOrderNum = globalOrderNum;
  }

  // --- इंटरनेट गड़बड़ फिक्स: मैसेज सॉर्टिंग नियम ---
  // नंबर 1 पर एड्रेस (टेक्स्ट), नंबर 2 पर फोटो, नंबर 3 पर स्टिकर/अन्य चीजें
  items.sort((a, b) => {
    if (a.type === 'text' && b.type !== 'text') return -1;
    if (a.type !== 'text' && b.type === 'text') return 1;
    return 0;
  });

  // इस यूजर का सारा सामान बिना किसी गैप के तुरंत एक साथ ग्रुप में जाएगा
  for (const item of items) {
    try {
      let sentMsg = null;

      if (item.type === 'photo') {
        // फोटो के नीचे कोई ऑर्डर आईडी (#ORD) नहीं लगेगी, सिर्फ नाम और आईडी
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (item.text !== "") {
          caption += `\n\n📝 विवरण: ${item.text}`;
        }
        sentMsg = await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption });
      } 
      else if (item.type === 'text') {
        if (isRealOrder) {
          // ऑर्डर आईडी केवल और केवल मुख्य एड्रेस वाले टेक्स्ट पर लगेगी
          let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #ORD${assignedOrderNum}*\n\n${item.text}`;
          sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
          await saveToSheet(assignedOrderNum, resellerName, userId, item.text);
        } else {
          // सामान्य मैसेज या स्टिकर
          sentMsg = await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬: ${item.text}`);
        }
      }

      // एडमिन के पास जो मैसेज गया उसकी ID को रिसेलर की ओरिजिनल मैसेज ID के साथ मैप करें
      if (sentMsg && item.originalMsgId) {
        adminToResellerMsgMap.set(sentMsg.message_id.toString(), item.originalMsgId);
      }
    } catch (e) {
      console.error("Group Delivery Error:", e.message);
    }
  }

  // अगले रिसेलर का पैकेट ठीक 15 सेकंड के लॉक के बाद ही खुलेगा
  setTimeout(processGlobalUserQueue, 15000);
}

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();

  // --- नियम १: एडमिन ग्रुप में सटीक रिप्लाई (जवाब) देना ---
  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      const adminRepliedMsgId = msg.reply_to_message.message_id.toString();
      
      // मैप से रिसेलर की ओरिजिनल मैसेज ID निकालें ताकि उसे कोट किया जा सके
      const originalResellerMsgId = adminToResellerMsgMap.get(adminRepliedMsgId);
      
      let replyOptions = {};
      if (originalResellerMsgId) {
        replyOptions.reply_to_message_id = parseInt(originalResellerMsgId);
      }

      if (msg.photo) {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(targetId, photoId, { 
          caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉",
          ...replyOptions 
        });
        return;
      }
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText, replyOptions);
        return;
      }
    }
    return;
  }

  // --- नियम २: रिसेलर्स के इनपुट को कतार (Queue) में जमा करना ---
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [] };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    // कतार में डालते समय रिसेलर के ओरिजिनल मैसेज की ID भी सुरक्षित रखें
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ 
        type: 'photo', 
        fileId: photoId, 
        text: cleanText,
        originalMsgId: msg.message_id 
      });
    } else if (cleanText !== "") {
      currentSession.messages.push({ 
        type: 'text', 
        text: cleanText,
        originalMsgId: msg.message_id 
      });
    }

    // रिसेलर को पूरा 25 सेकंड का समय दिया गया है
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
