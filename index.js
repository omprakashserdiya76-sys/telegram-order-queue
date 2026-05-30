const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को एक्टिव रखने के लिए सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Secure Queue Active'); });
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

// कतार का सारा डेटा प्रोसेस करने का मुख्य फंक्शन
async function processUserQueue(userId, resellerName) {
  const session = userSessions.get(userId);
  if (!session) return;

  const items = session.messages;
  userSessions.delete(userId); // कतार खाली करें

  // पूरी कतार में चेक करें कि कहीं कोई वैध एड्रेस है या नहीं
  let combinedText = items.map(i => i.text).join("\n").trim();
  const hasPin = /\b\d{6}\b/.test(combinedText);
  const hasPhone = /\b\d{10,12}\b/.test(combinedText);
  const isRealOrder = hasPin && hasPhone;

  let assignedOrderNum = null;
  if (isRealOrder) {
    globalOrderNum++;
    assignedOrderNum = globalOrderNum;
  }

  // कतार में आए सभी आइटम्स को एक-एक करके ग्रुप में भेजें (बिना मिक्स हुए)
  for (const item of items) {
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
        // शीट में सिर्फ एड्रेस वाला टेक्स्ट ही सेव करें
        await saveToSheet(assignedOrderNum, resellerName, userId, item.text);
      } else {
        // सामान्य मैसेज या Hi/Hello
        await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬: ${item.text}`);
      }
    }
  }
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

    if (!currentSession) {
      currentSession = { messages: [], timeoutId: null };
      userSessions.set(chatId, currentSession);
    }

    // टाइमर को रीसेट करें ताकि 20 सेकंड का गैप मिले
    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    // कतार में डेटा पुश करें
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText });
    }

    // 20 सेकंड शांत रहने के बाद ही ग्रुप में डेटा प्रोसेस होगा
    currentSession.timeoutId = setTimeout(() => {
      processUserQueue(chatId, resellerName);
    }, 20000);
  }
});
