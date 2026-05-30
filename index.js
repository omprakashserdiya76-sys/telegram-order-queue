const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को एक्टिव रखने के लिए सिंपल वेब सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Perfect Double Queue Active'); });
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

// रिसेलर्स के पैकेट्स को मैनेज करने के लिए कतार
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

// पैकेट्स को 15-15 सेकंड के अंतर पर एडमीन ग्रुप में भेजने वाला इंजन
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); // अगले यूजर का पैकेट निकालें
  const { userId, resellerName, items } = userTask;

  // चेक करें कि क्या यूजर ने इस पूरे पैकेट में कहीं वास्तविक एड्रेस भेजा है
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

  // इस यूजर का सारा सामान (एड्रेस + फोटो) बिना किसी गैप के तुरंत एक साथ ग्रुप में जाएगा
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
          // छोटे मैसेज या स्टिकर (बिना ऑर्डर आईडी के कम से कम शब्दों में)
          await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬: ${item.text}`);
        }
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

  // --- नियम २: रिसेलर्स के इनपुट को कतार (Queue) में जमा करना ---
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], timeoutId: null };
      userSessions.set(chatId, currentSession);
    }

    // टाइमर रीसेट लॉजिक: रिसेलर जब तक फोटो ढूंढकर भेज रहा है, टाइमर आगे बढ़ता रहेगा (मैक्स 25 सेकंड का होल्ड)
    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText });
    }

    // रिसेलर को गैलरी से फोटो ढूंढने और भेजने के लिए पूरा 25 सेकंड (25000ms) का समय मिलेगा
    currentSession.timeoutId = setTimeout(() => {
      const sessionToSend = userSessions.get(chatId);
      if (sessionToSend && sessionToSend.messages.length > 0) {
        globalUserQueue.push({
          userId: sessionToSend.userId,
          resellerName: sessionToSend.resellerName,
          items: [...sessionToSend.messages]
        });
        userSessions.delete(chatId); // इस यूजर की कतार लॉक करके खाली करें

        if (!isProcessingQueue) {
          processGlobalUserQueue();
        }
      }
    }, 25000); // 25 सेकंड का पूरा मौका रिसेलर के लिए
  }
});
