const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Daily Reset System Active (Perfect Fixed Mode)'); });
server.listen(port);

// हर रीсеलर की अलग गिनती और नाम का रिकॉर्ड रखने के लिए मैप
let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 

// --- नियम: रोजाना रात 12 बजे रीसेलर्स को नया मैसेज भेजना, ग्रुप में रिपोर्ट देना और रीसेट करना ---
function startDailyResetTimer() {
  setInterval(async () => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        
        let reportText = `📊 *Daily Orders Report (रात 12:00 बजे)* 📊\n`;
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        
        for (const [userId, count] of resellerOrderCounts.entries()) {
          const rName = resellerNamesMap.get(userId) || "Reseller";
          
          try {
            // नया शिपिंग चार्ज वाला मैसेज नियम के अनुसार
            const personalMsg = `नमस्कार! आज आपके कुल *${count}* ऑर्डर सफलतापूर्वक स्वीकार किए गए हैं\n\n` +
                                `* जिन ऑर्डर्स का COD अमाउंट ₹3900 से अधिक है, उन पर ₹200 शिपिंग चार्ज लगेगा।\n` +
                                `* बाकी सभी ऑर्डर्स पर ₹100 शिपिंग चार्ज लगेगा।\n` +
                                `मार्जिन जुड़वाने के लिए, कृपया शिपिंग चार्ज का भुगतान करें और रसीद मुझे व्हाट्सएप (8890438038)पर भेज दें। धन्यवाद!\n\n` +
                                `हमारे साथ काम करने के लिए धन्यवाद! 🙏`;
                                
            await bot.sendMessage(userId, personalMsg, { parse_mode: 'Markdown' });
          } catch (err) {
            console.error(`रीसेलर ${userId} को मैसेज भेजने में त्रुटि:`, err.message);
          }
          
          reportText += `👤 ${rName} (ID: ${userId}) — कुल ऑर्डर: *${count}*\n`;
        }
        
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `✅ सभी रीसेलर्स को समरी भेज दी गई है और काउंट 1 पर रीसेट कर दिया गया है!`;
        
        try {
          await bot.sendMessage(adminGroupId, reportText, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error("एडमिन ग्रुप में रिपोर्ट भेजने में त्रुटि:", err.message);
        }
        
        resellerOrderCounts.clear();
        resellerNamesMap.clear();
        console.log("सभी काउंट सफलतापूर्वक रीसेट कर दिए गए हैं।");
      }
    }
  }, 60000); 
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;

const adminToResellerMsgMap = new Map();

// एड्रेस पहचानने का फंक्शन
function isRealAddressText(txt) {
  if (!txt || txt.length < 30) return false;
  const digitsOnly = txt.replace(/\D/g, ""); 
  const hasValidPhone = /\d{10,12}/.test(digitsOnly);
  const hasPinCode = /\b\d{6}\b/.test(txt);
  return (hasValidPhone || hasPinCode);
}

// कतार इंजन (15 सेकंड का लॉक और बिना डेटा मिसिंग वाला परफेक्ट बंडल इंजन)
async function processGlobalUserQueue() {
  if (globalUserQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const userTask = globalUserQueue.shift(); 
  const { userId, resellerName, items } = userTask;

  resellerNamesMap.set(userId, resellerName);

  let subOrders = [];
  let currentOrderPhotos = [];
  let detectedAddresses = [];

  // 1. कतार में से सभी असली एड्रेसेस और सभी फोटोज़ को पूरी तरह अलग-अलग छांटना
  for (const item of items) {
    if (item.type === 'photo') {
      if (isRealAddressText(item.text)) {
        item.isRealAddress = true;
        detectedAddresses.push(item);
      } else {
        currentOrderPhotos.push(item);
      }
    } else if (item.type === 'text') {
      if (isRealAddressText(item.text)) {
        item.isRealAddress = true;
        detectedAddresses.push(item);
      } else {
        if (item.text.length >= 10) { // छोटे स्टिकर और छोटे टेक्स्ट बिना छेड़छाड़ के छोड़ना
          currentOrderPhotos.push(item);
        }
      }
    }
  }

  // 2. एड्रेस और फोटो को परफेक्ट बंडलों में लॉक करना
  if (detectedAddresses.length > 0) {
    if (detectedAddresses.length === 1) {
      subOrders.push({ address: detectedAddresses[0], photos: currentOrderPhotos });
    } 
    else {
      let photosPerOrder = Math.ceil(currentOrderPhotos.length / detectedAddresses.length);
      for (let i = 0; i < detectedAddresses.length; i++) {
        let startIdx = i * photosPerOrder;
        let endIdx = startIdx + photosPerOrder;
        let slicedPhotos = currentOrderPhotos.slice(startIdx, endIdx);
        subOrders.push({ address: detectedAddresses[i], photos: slicedPhotos });
      }
    }
  } else {
    // बिना ऑर्डर वाले खाली या सामान्य मैसेजेस को बिना ऑर्डर नंबर के कतार से सीधे निकालना
    if (currentOrderPhotos.length > 0) {
      subOrders.push({ address: null, photos: currentOrderPhotos });
    }
  }

  // 3. ग्रुप में डिलीवरी करना (नया फॉर्मेट नियम: ID के ठीक नीचे छोटा ऑर्डर नंबर)
  for (const subOrder of subOrders) {
    let mainAddressItem = subOrder.address;
    let orderPhotos = subOrder.photos;
    let assignedOrderNumStr = null;

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

    // A. ग्रुप में सबसे पहले एड्रेस मैसेज भेजना (नया नियम: ID के नीचे 📦 ORD #ऑर्डर नंबर)
    if (mainAddressItem) {
      try {
        let sentMsg = null;
        let orderHeader = `${mainAddressItem.text}\n\n👤 ${resellerName}\nID: ${userId}\n📦 ORD # ${assignedOrderNumStr}`;
        
        if (mainAddressItem.type === 'photo') {
          sentMsg = await bot.sendPhoto(adminGroupId, mainAddressItem.fileId, { caption: orderHeader, parse_mode: 'Markdown' });
        } else {
          sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'Markdown' });
        }
        if (sentMsg && mainAddressItem.originalMsgId) {
          adminToResellerMsgMap.set(sentMsg.message_id.toString(), mainAddressItem.originalMsgId);
        }
      } catch (e) { console.error("Address Sent Error:", e.message); }
    }

    // B. अब उस एड्रेस से जुड़ी हुई प्रोडक्ट फोटोज को ठीक उसके नीचे भेजना (नया नियम: फोटो के नीचे भी ID और ऑर्डर नंबर लॉक रहेगा)
    for (const photoItem of orderPhotos) {
      try {
        let sentMsg = null;
        if (photoItem.type === 'photo') {
          let caption = `👤 ${resellerName}\nID: ${userId}`;
          if (assignedOrderNumStr) {
            caption += `\n📦 ORD # ${assignedOrderNumStr}`;
          }
          if (photoItem.text !== "") caption += `\n\n📝 विवरण: ${photoItem.text}`;
          sentMsg = await bot.sendPhoto(adminGroupId, photoItem.fileId, { caption: caption });
        } else {
          // सामान्य बिना ऑर्डर वाले खाली मैसेजेस पर कोई आर्डर नंबर नहीं लगेगा
          let normalText = `👤 ${resellerName}\nID: ${userId}\n📝: ${photoItem.text}`;
          if (assignedOrderNumStr) {
            normalText = `👤 ${resellerName}\nID: ${userId}\n📦 ORD # ${assignedOrderNumStr}\n📝: ${photoItem.text}`;
          }
          sentMsg = await bot.sendMessage(adminGroupId, normalText);
        }
        if (sentMsg && photoItem.originalMsgId) {
          adminToResellerMsgMap.set(sentMsg.message_id.toString(), photoItem.originalMsgId);
        }
      } catch (e) { console.error("Photo Sent Error:", e.message); }
    }

    // C. डिवाइडर लगाना (केवल असली ऑर्डर्स के लिए)
    if (mainAddressItem) {
      try {
        await bot.sendMessage(adminGroupId, `🟢 *Next Order* 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'Markdown' });
      } catch (e) { console.error("Divider Error:", e.message); }
    }
  }

  // नियम: 15 सेकंड का लॉक टाइमर जो अलग-अलग रीसेलर्स के बीच गैप रखेगा
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

  // --- नियम: कतार कलेक्शन (25 सेकंड का होल्ड) ---
  if (chatId !== adminGroupId) {
    // छोटे स्टिकर या अंगूठे के निशान (9 अक्षरों से छोटे टेक्स्ट) को बिना किसी नाम/नंबर के सीधे आगे जाने देना
    if (!msg.photo && cleanText.length < 10 && cleanText !== "") {
      try {
        await bot.sendMessage(adminGroupId, `📝: ${cleanText}`);
      } catch (e) { console.error("Direct Text Error:", e.message); }
      return;
    }

    let currentSession = userSessions.get(chatId);

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [] };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id });
    }

    // 25 सेकंड का होल्ड टाइमर जो हर नए मैसेज पर रीसेट होता है
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
