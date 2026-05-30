const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर पोर्ट फिक्स
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Bot Active'); });
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

bot.on('message', async (msg) => {
  const userId = msg.chat.id.toString();
  let resellerName = msg.from.username || "Reseller";
  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();
  
  // एड्रेस की पहचान (6 डिजिट पिनकोड + 10 डिजिट फोन नंबर)
  const isAddress = (/\b\d{6}\b/.test(cleanText) && /\b\d{10}\b/.test(cleanText));

  // 1. फोटो को सिर्फ फॉरवर्ड करें (ऑर्डर न मानें)
  if (msg.photo) {
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    await bot.sendPhoto(adminGroupId, photoId, { caption: `👤 ${resellerName}\n📦 PARCEL PHOTO` });
    return;
  }

  // 2. सिर्फ एड्रेस वाले मैसेज को ऑर्डर मानें
  if (isAddress) {
    globalOrderNum++;
    let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 NEW ORDER #ORD${globalOrderNum}\n\n${cleanText}`;
    await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
    await saveToSheet(globalOrderNum, resellerName, userId, cleanText);
    return;
  }

  // 3. अन्य मैसेज
  if (cleanText !== "") {
    await bot.sendMessage(adminGroupId, `👤 ${resellerName}\n💬: ${cleanText}`);
  }
});
