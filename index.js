const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Daily Reset System Active (Summary Mode)'); });
server.listen(port);

// हर रीसेलर की अलग गिनती और नाम का रिकॉर्ड रखने के लिए मैप
let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 

// --- रोजाना रात 12 बजे रीसेलर्स को मैसेज भेजने, ग्रुप में रिपोर्ट देने और रीसेट करने का लॉजिक ---
function startDailyResetTimer() {
  setInterval(async () => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    // यदि रात के ठीक 12:00 बजे हैं
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        
        let reportText = `📊 *Daily Orders Report (रात 12:00 बजे)* 📊\n`;
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        
        // एक-एक करके सभी रीसेलर्स को प्रोसेस करना
        for (const [userId, count] of resellerOrderCounts.entries()) {
          const rName = resellerNamesMap.get(userId) || "Reseller";
          
          // 1. रीसेलर को पर्सनल टेलीग्राम मैसेज भेजना
          try {
            const personalMsg = `नमस्कार! आज आपके कुल *${count}* ऑर्डर सफलतापूर्वक स्वीकार किए गए हैं। हमारे साथ काम करने के लिए धन्यवाद! 🙏`;
            await bot.sendMessage(userId, personalMsg, { parse_mode: 'Markdown' });
          } catch (err) {
            console.error(`रीसेलर ${userId} को मैसेज भेजने में त्रुटि:`, err.message);
          }
          
          // रिपोर्ट की लाइन तैयार करना
          reportText += `👤 ${rName} (ID: ${userId}) — कुल ऑर्डर: *${count}*\n`;
        }
        
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `✅ सभी रीसेलर्स को समरी भेज दी गई है और काउंट 1 पर रीसेट कर दिया गया है!`;
        
        // 2. एडमिन ग्रुप में आपको फाइनल रिपोर्ट शो करना
        try {
          await bot.sendMessage(adminGroupId, reportText, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error("एडमिन ग्रुप में रिपोर्ट भेजने में त्रुटि:", err.message);
        }
        
        // 3. डेटा साफ करके काउंट 1 पर रीसेट करना
        resellerOrderCounts.clear();
        resellerNamesMap.clear();
        console.log("सभी काउंट सफलतापूर्वक रीसेट कर दिए गए हैं।");
      }
    }
  }, 60000); // हर मिनट चेक करेगा
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

  // 1. असली एड्रेस की सबसे समझदार पहचान
  for (const item of items) {
    if (item.type === 'text') {
      const txt = item.text.trim();
      
      const digitsOnly = txt.replace(/\D/g, ""); 
      const hasValidPhone = /\d{10,12}/.test(digitsOnly);
      const hasPinCode = /\b\d{6}\b/.test(txt);

      // नियम: लिखावट 30 अक्षर से बड़ी हो, और (मोबाइल नंबर या पिनकोड में से कोई भी एक हो)
      if (txt.length > 30 && (hasValidPhone || hasPinCode)) {
        mainAddressItem = item;
        item.isRealAddress = true;
        break;
      }
    }
  }

  if (mainAddressItem) {
    // रिकॉर्ड सुरक्षित रखना रात 12 बजे की रिपोर्ट के लिए
    resellerNamesMap.set(userId, resellerName);

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

  // 2. छोटे स्टिकर्स को हटाना और सॉर्टिंग करना
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

  // 3. ग्रुप में ऑर्डर डिलीवर करना
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

  // 15 सेकंड का लॉक टाइमर
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

    // 25 सेकंड का होल्ड टाइमर
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
