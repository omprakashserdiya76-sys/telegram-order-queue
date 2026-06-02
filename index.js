const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी के लिए
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { res.end('Engine Active - Absolute Fix Mode'); });
server.listen(port);

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 

function escapeHTML(text) {
  if (!text) return "";
  return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- नियम 1: रोजाना रात 12 बजे ग्रुप में पूरी रिपोर्ट भेजना और पर्सनल मैसेज भेजना ---
function startDailyResetTimer() {
  setInterval(async () => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        let reportText = `📊 <b>Daily Orders Report (रात 12:00 बजे)</b> 📊\n`;
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `आज सभी रीसेलर्स के कुल ऑर्डर्स की लिस्ट:\n\n`;
        
        for (const [userId, count] of resellerOrderCounts.entries()) {
          const rName = resellerNamesMap.get(userId) || "Reseller";
          const safeName = escapeHTML(rName);
          reportText += `👤 <b>${safeName}</b> (ID: ${userId}) — कुल आदेश: <b>${count}</b>\n`;
          
          try {
            const personalMsg = `नमस्कार! आज आपके कुल <b>${count}</b> ऑर्डर सफलतापूर्वक स्वीकार किए गए हैं\n\n` +
                                `* जिन ऑर्डर्स का COD अमाउंट ₹3900 से अधिक है, उन पर ₹200 शिपिंग charge लगेगा।\n` +
                                `* बाकी सभी ऑर्डर्स पर ₹100 शिपिंग charge लगेगा।\n` +
                                `मार्जिन जुड़वाने के लिए, कृपया शिपिंग charge का भुगतान करें और रसीद मुझे व्हाट्सएप (8890438038)पर भेज दें। धन्यवाद!\n\n` +
                                `हमारे साथ काम करने के लिए धन्यवाद! 🙏`;
            await bot.sendMessage(userId, personalMsg, { parse_mode: 'HTML' });
          } catch (err) {
            console.error(`Error sending personal report to ${userId}:`, err.message);
          }
        }
        
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `✅ सभी रीसेलर्स को पर्सनल समरी भेज दी गई है और काउंट रीसेट कर दिया गया है!`;
        
        try {
          await bot.sendMessage(adminGroupId, reportText, { parse_mode: 'HTML' });
        } catch (err) {
          console.error("Error sending report to admin group:", err.message);
        }
        
        resellerOrderCounts.clear();
        resellerNamesMap.clear();
      }
    }
  }, 60000); 
}
startDailyResetTimer();

const userSessions = new Map();
let globalUserQueue = [];
let isProcessingQueue = false;
const adminToResellerMsgMap = new Map();

// --- एड्रेस डिटेक्टर (स्पेस हटाना और 9-12 अंकों की रेंज) ---
function checkAddressDetails(txt) {
  if (!txt) return { isAddress: false, missing: 'both' };
  
  let cleanTxt = txt.toString().trim();
  if (cleanTxt.length < 20) return { isAddress: false, missing: 'both' };

  // मोबाइल नंबर के बीच के स्पेस को हटाना ताकि बोट नंबर को एक साथ पढ़ सके
  let textForPhoneCheck = cleanTxt.replace(/(?<=\d)\s+(?=\d)/g, "");

  const hasValidPhone = /\b\d{9,12}\b/.test(textForPhoneCheck);
  const hasPinCode = /\b\d{5,7}\b/.test(cleanTxt);

  if (hasValidPhone && hasPinCode) {
    return { isAddress: true, missing: 'none' };
  } else if (hasValidPhone && !hasPinCode) {
    return { isAddress: false, missing: 'pincode' };
  } else if (!hasValidPhone && hasPinCode) {
    return { isAddress: false, missing: 'phone' };
  }
  
  return { isAddress: false, missing: 'both' };
}

// कतार इंजन (15 सेकंड लॉक - बंडल डिलीवरी)
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
  let currentOrderMedia = [];
  let detectedAddresses = [];

  for (const item of items) {
    if (item.type === 'photo' || item.type === 'video') {
      let check = checkAddressDetails(item.text);
      if (check.isAddress) {
        item.isRealAddress = true;
        detectedAddresses.push(item);
      } else {
        currentOrderMedia.push(item);
      }
    } else if (item.type === 'text') {
      let check = checkAddressDetails(item.text);
      if (check.isAddress) {
        item.isRealAddress = true;
        detectedAddresses.push(item);
      } else {
        if (item.text.length >= 10) { 
          currentOrderMedia.push(item);
        }
      }
    }
  }

  if (detectedAddresses.length > 0) {
    if (detectedAddresses.length === 1) {
      subOrders.push({ address: detectedAddresses[0], media: currentOrderMedia });
    } else {
      let mediaPerOrder = Math.ceil(currentOrderMedia.length / detectedAddresses.length);
      for (let i = 0; i < detectedAddresses.length; i++) {
        let startIdx = i * mediaPerOrder;
        let endIdx = startIdx + mediaPerOrder;
        let slicedMedia = currentOrderMedia.slice(startIdx, endIdx);
        subOrders.push({ address: detectedAddresses[i], media: slicedMedia });
      }
    }
  } else {
    if (currentOrderMedia.length > 0) {
      subOrders.push({ address: null, media: currentOrderMedia });
    }
  }

  for (const subOrder of subOrders) {
    let mainAddressItem = subOrder.address;
    let orderMedia = subOrder.media;
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

    const safeResellerName = escapeHTML(resellerName);

    if (mainAddressItem) {
      try {
        let sentMsg = null;
        let safeAddressText = escapeHTML(mainAddressItem.text);
        let orderHeader = `${safeAddressText}\n\n👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
        
        if (mainAddressItem.type === 'photo') {
          sentMsg = await bot.sendPhoto(adminGroupId, mainAddressItem.fileId, { caption: orderHeader, parse_mode: 'HTML' });
        } else if (mainAddressItem.type === 'video') {
          sentMsg = await bot.sendVideo(adminGroupId, mainAddressItem.fileId, { caption: orderHeader, parse_mode: 'HTML' });
        } else {
          sentMsg = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
        }
        if (sentMsg && mainAddressItem.originalMsgId) {
          adminToResellerMsgMap.set(sentMsg.message_id.toString(), mainAddressItem.originalMsgId);
        }
      } catch (e) { console.error("Address Sent Error:", e.message); }
    }

    for (const mediaItem of orderMedia) {
      try {
        let sentMsg = null;
        let caption = `👤 ${safeResellerName}\nID: ${userId}`;
        if (assignedOrderNumStr) {
          caption += `\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
        }
        if (mediaItem.text && mediaItem.text !== "") {
          caption += `\n\n📝 विवरण: ${escapeHTML(mediaItem.text)}`;
        }

        if (mediaItem.type === 'photo') {
          sentMsg = await bot.sendPhoto(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
        } else if (mediaItem.type === 'video') {
          sentMsg = await bot.sendVideo(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
        } else {
          let normalText = `👤 ${safeResellerName}\nID: ${userId}\n📝: ${escapeHTML(mediaItem.text)}`;
          if (assignedOrderNumStr) {
            normalText = `👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>\n📝: ${escapeHTML(mediaItem.text)}`;
          }
          sentMsg = await bot.sendMessage(adminGroupId, normalText, { parse_mode: 'HTML' });
        }
        
        if (sentMsg && mediaItem.originalMsgId) {
          adminToResellerMsgMap.set(sentMsg.message_id.toString(), mediaItem.originalMsgId);
        }
      } catch (e) { console.error("Media Sent Error:", e.message); }
    }

    if (mainAddressItem) {
      try {
        await bot.sendMessage(adminGroupId, `🟢 <b>Next Order</b> 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'HTML' });
      } catch (e) { console.error("Divider Error:", e.message); }
    }
  }

  setTimeout(processGlobalUserQueue, 15000);
}

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let cleanText = (msg.text || msg.caption || "").trim();

  // एडमिन रिप्लाई रूट सिस्टम
  if (chatId === adminGroupId && msg.reply_to_message) {
    const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
    const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
    
    if (idMatch) {
      const targetId = idMatch[1].trim();
      const adminRepliedMsgId = msg.reply_to_message.message_id.toString();
      const originalResellerMsgId = adminToResellerMsgMap.get(adminRepliedMsgId);
      
      let replyOptions = {};
      if (originalResellerMsgId) replyOptions.reply_to_message_id = parseInt(originalResellerMsgId);

      if (msg.photo) {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        await bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.video) {
        const videoId = msg.video.file_id;
        await bot.sendVideo(targetId, videoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.text) {
        await bot.sendMessage(targetId, cleanText, replyOptions);
        return;
      }
    }
    return;
  }

  // --- रीसेलर साइड कलेक्शन और तुरंत रिजेक्शन अलर्ट ---
  if (chatId !== adminGroupId) {
    
    // 💡 महा-सुधार: कतार (Session) में डालने से पहले ही अधूरे एड्रेस को तुरंत रिजेक्ट करना
    if (msg.photo || msg.video) {
      let addrCheck = checkAddressDetails(cleanText);
      
      // अगर टेक्स्ट एड्रेस जैसा है (लंबाई 20 से ज्यादा) लेकिन पिनकोड या फोन गायब है
      if (!addrCheck.isAddress && (addrCheck.missing === 'pincode' || addrCheck.missing === 'phone' || addrCheck.missing === 'both')) {
        
        let missingDetailHindi = "पिनकोड या मोबाइल नंबर";
        if (addrCheck.missing === 'pincode') missingDetailHindi = "पिनकोड (Pincode)";
        if (addrCheck.missing === 'phone') missingDetailHindi = "मोबाइल नंबर (Mobile Number)";
        
        let alertMsg = `⚠️ <b>आपके एड्रेस में ${missingDetailHindi} गायब या सही नहीं है!</b>\n\n` +
                       `यह आपका आदेश आगे पैकिंग के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं या गायब है। यह मैसेज डिलीट कर दिया गया है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तो ही आदेश स्वीकार किया जाएगा।\n\n` +
                       `🚨 <b>कृपया मोबाइल नंबर, पिनकोड और प्रोडक्ट फोटो के साथ पूरा एड्रेस एक साथ दोबारा भेजें!</b> 🚨\n\n` +
                       `━━━━━━━━━━━━━━━━━━━━\n` +
                       `💡 <i>यदि आपको आदेश भेजने में कोई समस्या आ रही है या मदद की जरूरत है, तो आप मुझसे संपर्क कर सकते हैं:</i>\n\n` +
                       `👤 <b>ओमप्रकाश</b>\n` +
                       `📞 <code>9376535752</code>\n` +
                       `💬 @Omprakash9950`;

        try {
          await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
        } catch (e) { console.error("Alert Sender Failed:", e.message); }
        return; // यहीं से पूरी तरह साफ, आगे कतार में नहीं जाएगा!
      }
    }

    if (!msg.photo && !msg.video && cleanText.length < 10 && cleanText !== "") {
      try {
        await bot.sendMessage(adminGroupId, `📝: ${escapeHTML(cleanText)}`, { parse_mode: 'HTML' });
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
    } else if (msg.video) {
      const videoId = msg.video.file_id;
      currentSession.messages.push({ type: 'video', fileId: videoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id });
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
