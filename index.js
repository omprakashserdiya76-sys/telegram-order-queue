const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर को एक्टिव रखने के लिए सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Global Queue Active'); });
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

// ग्लोबल कतार (Queue) सिस्टम ताकि हर रिसेलर के मैसेज में 15 सेकंड का अंतर रहे
let globalQueue = [];
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

// कतार को एक-एक करके 15 सेकंड के गैप पर प्रोसेस करने वाला मुख्य इंजन
async function processGlobalQueue() {
  if (globalQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const task = globalQueue.shift(); // कतार से पहला मैसेज उठाएं

  try {
    if (task.actionType === 'send_photo') {
      await bot.sendPhoto(adminGroupId, task.fileId, { caption: task.caption, parse_mode: task.parseMode });
    } else if (task.actionType === 'send_message') {
      await bot.sendMessage(adminGroupId, task.text, { parse_mode: task.parseMode });
    }
  } catch (error) {
    console.error("Queue Send Error:", error.message);
  }

  // अगला मैसेज ठीक 15 सेकंड (15000 मिलीसेकंड) के बाद ही जाएगा, चाहे रिसेलर्स ने एक साथ भेजा हो
  setTimeout(processGlobalQueue, 15000);
}

// कतार में नया टास्क जोड़ने का फंक्शन
function addToGlobalQueue(task) {
  globalQueue.push(task);
  if (!isProcessingQueue) {
    processGlobalQueue();
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

  // --- नियम २: रिसेलर्स के आने वाले मैसेज (प्राइवेट चैट) ---
  if (chatId !== adminGroupId) {
    
    // शुद्ध एड्रेस की सटीक पहचान (लंबा टेक्स्ट + पिनकोड + फोन नंबर होना अनिवार्य)
    const isLongEnough = cleanText.length > 30;
    const hasPin = /\b\d{6}\b/.test(cleanText);
    const hasPhone = /\b\d{10,12}\b/.test(cleanText);
    const isAddress = isLongEnough && hasPin && hasPhone;

    // ए) अगर रिसेलर ने फोटो या स्टिकर/इमोजी मीडिया भेजा है
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      let photoCaption = `👤 ${resellerName}\nID: ${chatId}`;
      if (cleanText !== "") {
        photoCaption += `\n📝 विवरण: ${cleanText}`;
      }
      
      // कतार में डालें - बिना किसी ऑर्डर आईडी (#ORD) के, कम से कम शब्दों में
      addToGlobalQueue({
        actionType: 'send_photo',
        fileId: photoId,
        caption: photoCaption
      });
      return;
    }

    // बी) अगर रिसेलर ने शुद्ध एड्रेस भेजा है (तभी ऑर्डर नंबर जनरेट होगा और शीट में जाएगा)
    if (isAddress) {
      globalOrderNum++;
      let orderHeader = `👤 ${resellerName}\nID: ${chatId}\n\n📦 *NEW ORDER #ORD${globalOrderNum}*\n\n${cleanText}`;
      
      // शीट में तुरंत सेव करें ताकि डेटा सुरक्षित रहे
      await saveToSheet(globalOrderNum, resellerName, chatId, cleanText);
      
      // कतार में जोड़ें ताकि 15 सेकंड के अंतराल पर ग्रुप में पोस्ट हो
      addToGlobalQueue({
        actionType: 'send_message',
        text: orderHeader,
        parseMode: 'Markdown'
      });
      return;
    }

    // सी) स्टिकर, इमोजी या कोई छोटा-मोटा मैसेज (Hi, Hello, Ok, या दिल ❤️ का स्टिकर)
    if (cleanText !== "") {
      // कम से कम शब्दों में ग्रुप में भेजना (कोई ऑर्डर नंबर नहीं लगेगा)
      let shortMessage = `👤 ${resellerName}\nID: ${chatId}\n💬: ${cleanText}`;
      
      addToGlobalQueue({
        actionType: 'send_message',
        text: shortMessage
      });
    }
  }
});
