const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// 🛠️ रेंडर पोर्ट स्कैन एरर को रोकने के लिए बाईपास सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running perfectly!\n');
});
server.listen(port, () => {
  console.log(`रेंडर पोर्ट बाईपास एक्टिव है: ${port}`);
});

// इन-मेमोरी डेटाबेस (20 सेकंड का ताला लगाने के लिए)
const userSessions = new Map();
let globalOrderNum = 100;

bot.on('message', async (msg) => {
  if (!msg.chat || msg.chat.type !== 'private') {
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

  const isPurePhone = /^\d{10}$/.test(cleanText);
  const isPurePin = /^\d{6}$/.test(cleanText);
  const hasAddressKeywords = cleanText.length >= 30 && (/\b\d{6}\b/.test(cleanText) || /\b\d{10}\b/.test(cleanText));

  if (isPurePhone || isPurePin || (!hasAddressKeywords && !msg.photo)) {
    if (cleanText !== "") {
      await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n💬 मैसेज: ${cleanText}`);
    }
    return;
  }

  const now = Date.now();
  let session = userSessions.get(userId);

  if (!session || (now - session.lastTime) > 20000) {
    globalOrderNum++;
    session = { orderNum: globalOrderNum, lastTime: now };
    userSessions.set(userId, session);
  } else {
    session.lastTime = now;
  }

  if (msg.photo) {
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    let photoHeader = `👤 ${resellerName}\nID: ${userId}\n📦 *ORDER #ORD${session.orderNum} (PARCEL PHOTO)*\n\n${cleanText}`;
    await bot.sendPhoto(adminGroupId, photoId, { caption: photoHeader, parse_mode: 'Markdown' });
  } 
  else if (hasAddressKeywords) {
    let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *ORDER #ORD${session.orderNum}*\n\n${cleanText}`;
    await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
  }
});

console.log("कतार (Queue) बोट रेंडर पर पूरी तरह फिक्स और लाइव हो चुका है...");
