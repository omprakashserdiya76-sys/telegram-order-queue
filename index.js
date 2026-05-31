const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Daily Reset System Active (No Sheet Mode)'); });
server.listen(port);

// हर रीसेलर की अलग गिनती रखने के लिए मैप (यूजर आईडी के आधार पर)
let resellerOrderCounts = new Map();

// --- रोजाना रात 12 बजे प्रत्येक रीसेलर का ऑर्डर आईडी 1 पर रीसेट करने का लॉजिक ---
function startDailyResetTimer() {
  setInterval(() => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        resellerOrderCounts.clear();
        console.log("सभी रीसेलर्स के ऑर्डर नंबर सफलतापूर्वक रात 12 बजे रीसेट होकर 1 पर आ गए हैं!");
      }
    }
  }, 60000); 
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

const adminToResellerMsgMap = new Map();

// कतार इंजन (15 सेकंड का锁)
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); 
  const { userId, resellerName, items } = userTask;

  let mainAddressItem = null;
  let assignedOrderNumStr = null;

  // 1. असली एड्रेस की महा-समझदार पहचान (अपग्रेडेड लॉजिक)
  for (const item of items) {
    if (item.type === 'text') {
      const txt = item.text.trim();
      
      // टेक्स्ट में से सारे स्पेस, डैश, कोष्ठक हटाकर केवल शुद्ध अंक (Digits) निकालना
      const digitsOnly = txt.replace(/\D/g, ""); 
      
      // क्या शुद्ध अंकों में कहीं भी लगातार 10, 11 या 12 अंकों का मोबाइल नंबर छिपा है?
      const hasValidPhone = /\d{10,12}/.test(digitsOnly);
      
      // क्या टेक्स्ट में 6 अंकों का पिनकोड मौजूद है?
      const hasPinCode = /\b\d{6}\b/.test(txt);

      // अगर कुल लिखावट 30 अक्षर से बड़ी है, पिनकोड है और कैसा भी मोबाइल नंबर है
      if (txt.length > 30 && hasPinCode && hasValidPhone) {
        mainAddressItem = item;
        item.isRealAddress = true;
        break;
      }
    }
  }

  if (mainAddressItem) {
    let currentCount = resellerOrderCounts.get(userId) || 0;
    currentCount++;
    resellerOrderCounts.set(userId, currentCount);

    let cleanName = resellerName.replace(/[^a-zA-Z0-9]/g, "");
    let namePart = cleanName.substring(0, 2).toUpperCase();
    if (namePart.length < 2) namePart = "OR";

    let idStr = userId.toString();
    let idPart = idStr.substring(idStr.length - 1);

    let prefix = `${namePart}${idPart}`;
    let paddedCount = currentCount.toString().padStart(3, '0');
    assignedOrderNumStr = `${prefix}-${paddedCount}`;
  }

  let filteredItems = items.filter(item => {
    if (item.type === 'text' && !item.isRealAddress) {
      if (item.text.length < 10) return false;
    }
    return true;
  });

  filteredItems.sort((a, b) => {
    if (a.isRealAddress) return -1;
    if (b.isRealAddress) return 1;
    if (a.type === 'photo' && b.type !== 'photo') return -1;
    if (a.type !== 'photo' && b.type === 'photo') return 1;
    return 0;
  });

  for (const item of filteredItems) {
    try {
      let sentMsg = null;

      if (item.type === 'photo') {
        let caption = `👤 ${resellerName}\nID: ${userId}`;
        if (item.text !== "") {
          caption += `\n\n📝 विवरण: ${item.text}`;
        }
        sentMsg = await bot.sendPhoto(adminGroupId, item.fileId, { caption: caption });
      } 
      else if (item.type === 'text' && item.isRealAddress) {
        let orderHeader = `👤 ${resellerName}\nID: ${userId}\n\n📦 *NEW ORDER #${assignedOrderNumStr}*\n\n${item.text}`;
        sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
      }
      else if (item.type === 'text') {
        sentMsg = await bot.sendMessage(adminGroupId, `👤 ${resellerName}\nID: ${userId}\n📝: ${item.text}`);
      }

      if (sentMsg && item.originalMsgId) {
        adminToResellerMsgMap.set(sentMsg.message_id.toString(), item.originalMsgId);
      }
    } catch (e) {
      console.error("Delivery Error:", e.message);
    }
  }

  if (mainAddressItem) {
    try {
      await bot.sendMessage(adminGroupId, `🟢 *Next Order* 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Divider Error:", e.message); }
  }

  setTimeout(processGlobalUserQueue, 15000);
}

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let text = msg.text || msg.caption || "";
  let cleanText = text.trim();

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
        await bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText, replyOptions);
        return;
      }
    }
    return;
  }

  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [] };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, originalMsgId: msg.message_id, isRealAddress: false });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id, isRealAddress: false });
    }

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
