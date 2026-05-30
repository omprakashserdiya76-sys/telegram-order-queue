const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को लाइव रखने के लिए सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('User Based Lock Active'); });
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

// रिसेलर्स के मैसेजेस को मैनेज करने के लिए कतार सिस्टम
const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

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

// पूरे यूजर का पैकेट एक साथ ग्रुप में भेजने वाला इंजन
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); // कतार से अगले यूजर का पूरा पैकेट उठाएं
  const { userId, resellerName, items } = userTask;

  // चेक करें कि इस पूरे पैकेट में कहीं कोई वैध एड्रेस है या नहीं
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

  // इस यूजर के जितने भी मैसेज/फोटो हैं, वे तुरंत बिना किसी गैप के एक साथ ग्रुप में जाएंगे
  for (const item of items) {
    try {
      if (item.type === 'photo') {
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (assignedOrderNum) {
          caption += `\n📦 *ORDER #ORD${assignedOrderNum}*`;
        }
        if (item.text !== "") {
          caption += `\n\n📝 विवरण: ${item.text}`;
        }
        await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption, parse_mode: 'Markdown' });
      } 
      else if (item.type === 'text') {
        if (isRealOrder) {
          let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #ORD${assignedOrderNum}*\n\n${item.text}`;
          await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
          await saveToSheet(assignedOrderNum, resellerName, userId, item.text);
        } else {
          // सामान्य मैसेज या स्टिकर टेक्स्ट (बिना ऑर्डर आईडी के)
          await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬: ${item.text}`);
        }
      }
    } catch (e) {
      console.error("Sending Error:", e.message);
    }
  }

  // अगले यूजर (रिसेलर B) का नंबर ठीक 15 सेकंड के लॉक के बाद ही आएगा
  setTimeout(processGlobalUserQueue, 15000);
}

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();

  // --- नियम १: एडमिन ग्रुप में रिप्लाई (जवाब) देना ---
  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      if (msg.photo) {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉" });
        return;
      }
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText);
        return;
      }
    }
    return;
  }

  // --- नियम २: रिसेलर्स के इनपुट को कतार (Queue) में डालना ---
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);

    // अगर इस यूजर का नया सेशन है, तो बनाएं
    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], timeoutId: null };
      userSessions.set(chatId, currentSession);
    }

    // रिसेलर जब तक फटाफट टाइप कर रहा या फोटो सेंड कर रहा है (2 सेकंड का छोटा होल्ड ताकि सारे मैसेज इकट्ठे हो जाएं)
    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText });
    }

    // जैसे ही इस रिसेलर ने भेजना बंद किया, उसका पूरा पैकेट मेन ग्लोबल कतार में चला जाएगा
    currentSession.timeoutId = setTimeout(() => {
      const sessionToSend = userSessions.get(chatId);
      if (sessionToSend && sessionToSend.messages.length > 0) {
        globalUserQueue.push({
          userId: sessionToSend.userId,
          resellerName: sessionToSend.resellerName,
          items: [...sessionToSend.messages]
        });
        userSessions.delete(chatId); // इस यूजर का सेशन खाली करें

        // अगर कतार रुकी हुई है, तो इंजन चालू करें
        if (!isProcessingQueue) {
          processGlobalUserQueue();
        }
      }
    }, 2000); // 2 सेकंड का बफर ताकि एक यूजर की फोटो और टेक्स्ट आपस में जुड़ सकें
  }
});
