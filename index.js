const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// रेंडर की सेटिंग्स से वैल्यू उठाना
const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;
const spreadsheetId = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(token, { polling: true });

// इन-मेमोरी डेटाबेस (सच्ची कतार और ताला लगाने के लिए)
const userSessions = new Map();
let globalOrderNum = 100;

// गूगल शीट ऑथेंटिकेशन (यह बोट रेंडर से सीधे आपकी शीट में लिखेगा)
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

bot.on('message', async (msg) => {
  if (!msg.chat || msg.chat.type !== 'private') {
    // अगर एडमिन ग्रुप में रिप्लाई आया है तो रिसेलर को फॉरवर्ड करना
    if (msg.chat.id.toString() === adminGroupId && msg.reply_to_message) {
      const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
      const idMatch = sourceText.match(/ID:\s*(-?\d+)/i);
      if (idMatch) {
        const targetId = idMatch[1].trim();
        if (msg.photo) {
          await bot.sendPhoto(targetId, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "🎁 पार्सल पैक हो गया है!" });
        } else if (msg.text) {
          await bot.sendMessage(targetId, msg.text);
        }
      }
    }
    return;
  }

  const userId = msg.chat.id.toString();
  let resellerName = msg.from.username || `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "Reseller";
  let textContent = msg.text || msg.caption || "";
  let cleanText = textContent.trim();

  // 🔍 [सख्त फ़िल्टर] सिंगल मोबाइल नंबर (10 डिजिट) या पिनकोड (6 डिजिट) को आर्डर काउंट करने से रोकना
  const isPurePhone = /^\d{10}$/.test(cleanText);
  const isPurePin = /^\d{6}$/.test(cleanText);
  const hasAddressKeywords = cleanText.length >= 35 && (/\b\d{6}\b/.test(cleanText) || /\b\d{10}\b/.test(cleanText));

  // अगर रिसेलर ने सिर्फ हाय-हेलो या सिंगल नंबर भेजा है, तो बिना आर्डर नंबर के ग्रुप में फेंक दो
  if (isPurePhone || isPurePin || !hasAddressKeywords && !msg.photo) {
    if (cleanText !== "") {
      await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬 मैसेज: ${cleanText}`);
    }
    return;
  }

  // ⏳ 20 सेकंड कतार और ताला प्रणाली (True Waiting Room Lock)
  const now = Date.now();
  let session = userSessions.get(userId);

  if (!session || (now - session.lastTime) > 20000) {
    // अगर 20 सेकंड बीत चुके हैं या नया यूजर है, तो नया आर्डर नंबर जनरेट होगा
    globalOrderNum++;
    session = {
      orderNum: globalOrderNum,
      lastTime: now,
      textSent: false,
      photoSent: false
    };
    userSessions.set(userId, session);
  } else {
    // अगर 20 सेकंड के अंदर ही काम हो रहा है, तो टाइमर को और आगे बढ़ा दें ताकि पूरा आर्डर आ सके
    session.lastTime = now;
  }

  // अगर फोटो आई है
  if (msg.photo) {
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    let photoHeader = `👤 ${resellerName}\nID: ${userId}\n📦 *ORDER #ORD${session.orderNum} (PARCEL PHOTO)*\n\n${cleanText}`;
    await bot.sendPhoto(adminGroupId, photoId, { caption: photoHeader, parse_mode: 'Markdown' });
    session.photoSent = true;
  } 
  // अगर पूरा लंबा एड्रेस आया है
  else if (hasAddressKeywords) {
    let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *ORDER #ORD${session.orderNum}*\n\n${cleanText}`;
    await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
    
    // गूगल शीट में एंट्री करने का लॉजिक (मास्टर शीट और काउंट अपडेट)
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      // 1. मास्टर शीट में एड्रेस सेव करना
      await sheets.spreadsheets.values.append({
        spreadsheetId, range: 'Master_Sheet!A:A',
        valueInputOption: 'USER_ENTERED', requestBody: { values: [[cleanText]] }
      });
      
      // 2. ऑर्डर काउंट सेम लाइन में अपडेट करना
      let todayDate = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
      // (नोट: यहाँ सर्वर बैकएंड में काउंट को मैनेज कर लेगा)
    } catch (err) { console.error("Sheet Error:", err); }

    session.textSent = true;
  }
});

console.log("कतार और एंटी-मिक्सिंग बोट रेंडर पर सफलतापूर्वक चालू है...");

