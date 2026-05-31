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
    // इंडिया टाइमज़ोन के हिसाब से घंटे और मिनट निकालना
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    // अगर रात के ठीक 12 बजकर 0 मिनट हुए हैं, तो सभी की गिनती साफ करके 1 से शुरू करें
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        resellerOrderCounts.clear();
        console.log("सभी रीसेलर्स के ऑर्डर नंबर सफलतापूर्वक रात 12 बजे रीसेट होकर 1 पर आ गए हैं!");
      }
    }
  }, 60000); // हर एक मिनट में बैकग्राउंड में चेक करेगा
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

const adminToResellerMsgMap = new Map();

// कतार इंजन (15 सेकंड का लॉक)
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

  // 1. असली एड्रेस की पहचान
  for (const item of items) {
    if (item.type === 'text') {
      const txt = item.text.trim();
      if (txt.length > 30 && /\b\d{6}\b/.test(txt) && /\b\d{10,12}\b/.test(txt)) {
        mainAddressItem = item;
        item.isRealAddress = true;
        break;
      }
    }
  }

  if (mainAddressItem) {
    // यूजर आईडी (userId) के आधार पर इस विशिष्ट रीसेलर के लिए नंबर बढ़ाना
    let currentCount = resellerOrderCounts.get(userId) || 0;
    currentCount++;
    resellerOrderCounts.set(userId, currentCount);

    // रीसेलर के नाम के पहले 3 अक्षर निकालना (जैसे स्वरूप के लिए SWA)
    let prefix = resellerName.replace(/[^a-zA-Z0-9]/g, "").substring(0, 3).toUpperCase();
    if (prefix.length < 3) prefix = "ORD";

    // सुंदर फॉर्मेट तैयार करना (जैसे: SWA-001, SWA-002)
    let paddedCount = currentCount.toString().padStart(3, '0');
    assignedOrderNumStr = `${prefix}-${paddedCount}`;
  }

  // 2. छोटे स्टिकर्स/इमोजी को हटाना और सॉर्टिंग करना
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

  // 3. लाइन से ग्रुप में डिलीवर करना
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
        // यहाँ नया कस्टमाइज्ड ऑर्डर नंबर साफ-साफ दिखेगा
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

  // 4. ऑटोमेटिक Next Order डिवाइडर संदेश
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

  // --- एडमिन रिप्लाई रूट सिस्टम ---
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

  // --- कतार कलेक्शन (25 सेकंड का होल्ड) ---
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
