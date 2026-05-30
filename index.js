const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को एक्टिव रखने के लिए सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Strict Sorting System Live'); });
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

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

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

  // यह चेक करने के लिए कि इस पूरे पैकेट में असली एड्रेस कौनसा है
  let mainAddressItem = null;
  let assignedOrderNum = null;

  // सभी आइटम्स को चेक करें और असली बड़े एड्रेस की पहचान करें
  for (const item of items) {
    if (item.type === 'text') {
      const txt = item.text.trim();
      const isLongEnough = txt.length > 30;
      const hasPin = /\b\d{6}\b/.test(txt);
      const hasPhone = /\b\d{10,12}\b/.test(txt);
      
      if (isLongEnough && hasPin && hasPhone) {
        mainAddressItem = item;
        item.isRealAddress = true; // इसे असली एड्रेस मार्क कर दें
        break;
      }
    }
  }

  // अगर असली एड्रेस मिल गया है, तो ही नया ऑर्डर नंबर जनरेट करें
  if (mainAddressItem) {
    globalOrderNum++;
    assignedOrderNum = globalOrderNum;
  }

  // --- सख्त नियम: लाइन वाइज सॉर्टिंग (1. एड्रेस, 2. फोटो, 3. स्टिकर) ---
  items.sort((a, b) => {
    // क) असली एड्रेस हमेशा सबसे पहले (नंबर 1 पर) आएगा
    if (a.isRealAddress) return -1;
    if (b.isRealAddress) return 1;

    // ख) फोटो हमेशा दूसरे नंबर पर आएगी
    if (a.type === 'photo' && b.type !== 'photo') return -1;
    if (a.type !== 'photo' && b.type === 'photo') return 1;

    // ग) छोटे मैसेज या स्टिकर हमेशा सबसे आखिर में जाएंगे
    return 0;
  });

  // अब बिना किसी गैप के लाइन से मैसेज ग्रुप में भेजना शुरू करें
  for (const item of items) {
    try {
      let sentMsg = null;

      if (item.type === 'photo') {
        // फोटो पर कोई ऑर्डर आईडी नहीं लगेगी
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (item.text !== "") {
          caption += `\n\n📝 विवरण: ${item.text}`;
        }
        sentMsg = await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption });
      } 
      else if (item.type === 'text') {
        if (item.isRealAddress) {
          // ऑर्डर आईडी केवल और केवल मुख्य एड्रेस पर ही लगेगी
          let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #ORD${assignedOrderNum}*\n\n${item.text}`;
          sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
          await saveToSheet(assignedOrderNum, resellerName, userId, item.text);
        } else {
          // स्टिकर, इमोजी या छोटे मैसेज पर कोई आईडी नहीं लगेगी, यह बिना आईडी के जाएगा
          sentMsg = await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬: ${item.text}`);
        }
      }

      if (sentMsg && item.originalMsgId) {
        adminToResellerMsgMap.set(sentMsg.message_id.toString(), item.originalMsgId);
      }
    } catch (e) {
      console.error("Group Delivery Error:", e.message);
    }
  }

  // अगले रिसेलर का पैकेट ठीक 15 सेकंड के सख्त लॉक के बाद ही खुलेगा
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

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ 
        type: 'photo', 
        fileId: photoId, 
        text: cleanText,
        originalMsgId: msg.message_id,
        isRealAddress: false
      });
    } else if (cleanText !== "") {
      currentSession.messages.push({ 
        type: 'text', 
        text: cleanText,
        originalMsgId: msg.message_id,
        isRealAddress: false
      });
    }

    // रिसेलर को पूरा 25 सेकंड का समय
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
