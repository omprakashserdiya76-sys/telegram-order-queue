const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर पोर्ट बाइंडिंग
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Bot Active'); });
server.listen(port);

// गूगल शीट क्रेडेंशियल
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
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  const userId = msg.from.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();

  // --- नियम 1: एडमिन ग्रुप में रिप्लाई का जवाब देना (रिसेलर को पार्सल फोटो या मैसेज भेजना) ---
  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    
    // रिसेलर की ID ढूंढना (ID: 123456789 फॉर्मेट से)
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      
      // ए) अगर एडमिन ने रिप्लाई में फोटो भेजी है (पार्सल की फोटो)
      if (msg.photo) {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉" });
        return;
      }
      
      // बी) अगर एडमिन ने रिप्लाई में सिर्फ टेक्स्ट मैसेज भेजा है
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText);
        return;
      }
    }
    return;
  }

  // --- नियम 2: रिसेलर्स के आने वाले मैसेज को हैंडल करना (प्राइवेट चैट) ---
  if (chatId !== adminGroupId) {
    
    // एड्रेस की सटीक पहचान (6 अंकों का पिनकोड और 10 अंकों का फोन नंबर)
    const hasPin = /\b\d{6}\b/.test(cleanText);
    const hasPhone = /\b\d{10,12}\b/.test(cleanText);
    const isAddress = hasPin && hasPhone;

    // अगर रिसेलर ने फोटो भेजी है (बिना रिप्लाई के - नॉर्मल पार्सल फोटो)
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      let photoCaption = `👤 ${resellerName}\nID: ${chatId}`;
      if (cleanText !== "") {
        photoCaption += `\n\n📝 विवरण: ${cleanText}`;
      }
      await bot.sendPhoto(adminGroupId, photoId, { caption: photoCaption });
      return;
    }

    // अगर सिर्फ टेक्स्ट मैसेज है और वह एड्रेस है
    if (isAddress) {
      globalOrderNum++;
      let orderHeader = `👤 ${resellerName}\nID: ${chatId}\n\n📦 *NEW ORDER #ORD${globalOrderNum}*\n\n${cleanText}`;
      
      await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
      await saveToSheet(globalOrderNum, resellerName, chatId, cleanText);
      return;
    }

    // सामान्य बातचीत या मैसेज
    if (cleanText !== "") {
      if (cleanText.length > 30) {
        await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${chatId}\n⚠️ *अधूरा एड्रेस या मैसेज:*\n\n${cleanText}`);
      } else {
        await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${chatId}\n💬 मैसेज: ${cleanText}`);
      }
    }
  }
});
