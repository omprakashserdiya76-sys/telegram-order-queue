const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Omprakash Ji Super Clear Summary Production Mode v9'); 
});
server.listen(port);

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 
let recentOrdersMap = new Map(); // 30 मिनट डुप्लीकेट लॉक के लिए

let globalDeliveryQueue = [];
let isProcessingQueue = false;

// रीसेलर्स के चालू ऑर्डर सेशन को संभालने के लिए
// स्टेटस: 'collecting' (डेटा ले रहा है), 'verifying' (पुष्टि मांग रहा है)
const userSessions = new Map();
const adminToResellerMsgMap = new Map();

// स्टाइलिश/बोल्ड गणितीय नंबरों को नॉर्मल 0-9 में बदलने वाला क्लीनर इंजन
function normalizeStylisedText(text) {
  if (!text) return "";
  let str = text.toString();
  
  const stylishNumbers = {
    '𝟬': '0', '𝟭': '1', '𝟮': '2', '𝟯': '3', '𝟰': '4', '𝟱': '5', '𝟲': '6', '𝟳': '7', '𝟴': '8', '𝟵': '9',
    '𝟶': '0', '𝟷': '1', '𝟸': '2', '𝟹': '3', '𝟴': '8', '𝟻': '5', '𝟼': '6', '𝟽': '7', '𝟾': '8', '𝟿': '9',
    '⓪': '0', '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9',
    '🄀': '0', '⒈': '1', '⒉': '2', '⒊': '3', '⒋': '4', '⒌': '5', '⒍': '6', '⒎': '7', '⒏': '8', '⒐': '9',
    '⓿': '0', '❶': '1', '❷': '2', '❸': '3', '❹': '4', '❺': '5', '❻': '6', '❼': '7', '❽': '8', '❾': '9'
  };

  return str.split('').map(char => stylishNumbers[char] || char).join('');
}

function escapeHTML(text) {
  if (!text) return "";
  return text.toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- कीबोर्ड बटन्स टेम्पलेट्स ---
// मुख्य परमानेंट कीबोर्ड (हमेशा केवल यही दो बटन मुख्य स्क्रीन पर दिखेंगे)
const permanentMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "🔴 ऑर्डर पूरा हुआ" }],
      [{ text: "❌ ऑर्डर रद्द करें / Cancel" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// भूल से बटन दबने से रोकने के लिए डबल वेरिफिकेशन कीबोर्ड
const confirmationMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "✅ हाँ, फाइनल है (भेजें)" }],
      [{ text: "🔙 नहीं, अभी सामान बाकी है" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// --- 📊 रोजाना रात 12 बजे ग्रुप में एकदम क्लियर और खुला-खुला रिपोर्ट लेआउट भेजना ---
function startDailyResetTimer() {
  setInterval(async () => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    if (indiaTime.getHours() === 0 && indiaTime.getMinutes() === 0) {
      if (resellerOrderCounts.size > 0) {
        let reportText = `📊 <b>Daily Orders Report (रात 12:00 बजे)</b> 📊\n`;
        reportText += `━━━━━━━━━━━━━━━━━━━━\n`;
        reportText += `आज सभी रीसेलर्स के कुल ऑर्डर्स की लिस्ट:\n\n`;
        
        // एक-एक करके रीसेलर का डेटा एकदम खुला-खुला और साफ़ लाइन में जोड़ना
        for (const [userId, count] of resellerOrderCounts.entries()) {
          const rName = resellerNamesMap.get(userId) || "Reseller";
          const safeName = escapeHTML(rName);
          
          reportText += `👤 <b>नाम:</b> ${safeName}\n`;
          reportText += `🆔 <b>ID:</b> <code>${userId}</code>\n`;
          reportText += `📦 <b>कुल ऑर्डर:</b> <b>${count}</b>\n`;
          reportText += `━━━━━━━━━━━━━━━━━━━━\n\n`; // हर नाम के बाद एक क्लियर बॉर्डर लाइन और स्पेस
          
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

// --- ⚙️ सुधरा हुआ अचूक एड्रेस डिटेक्टर इंजन (मकान नंबर और 2 मोबाइल नंबर से सुरक्षित) ---
function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") {
    return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: "" };
  }
  
  let cleanTxt = normalizeStylisedText(txt).trim();
  
  if (cleanTxt.length < 35) {
    return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: cleanTxt };
  }

  // शुद्ध 10 अंकों का स्वतंत्र मोबाइल नंबर खोजना (जो 6-9 से शुरू हो)
  const phoneRegex = /(?<!\d)(?:91)?[6-9]\d{9}(?!\d)/g;
  let phoneMatches = [];
  let match;
  
  while ((match = phoneRegex.exec(cleanTxt)) !== null) {
    let rawNum = match[0];
    if (rawNum.startsWith('91') && rawNum.length > 10) {
      rawNum = rawNum.substring(2);
    }
    if (rawNum.length === 10) {
      phoneMatches.push(rawNum);
    }
  }

  if (phoneMatches.length === 0) {
    let secondaryTxt = cleanTxt.replace(/(?<=\d)[\s-]+(?=\d)/g, "");
    let secondMatch;
    const phoneRegexSec = /(?<!\d)(?:91)?[6-9]\d{9}(?!\d)/g;
    while ((secondMatch = phoneRegexSec.exec(secondaryTxt)) !== null) {
      let rawNum = secondMatch[0];
      if (rawNum.startsWith('91') && rawNum.length > 10) {
        rawNum = rawNum.substring(2);
      }
      if (rawNum.length === 10 && !phoneMatches.includes(rawNum)) {
        phoneMatches.push(rawNum);
      }
    }
  }

  let hasValidPhone = phoneMatches.length > 0;
  let isPhoneIncomplete = false;

  if (!hasValidPhone) {
    let fallbackDigits = cleanTxt.match(/(?<!\d)[6-9]\d{5,8}(?!\d)/g);
    if (fallbackDigits && fallbackDigits.some(d => d.length === 9 || d.length === 7 || d.length === 8)) {
      isPhoneIncomplete = true;
    }
  }

  // शुद्ध 6 अंकों का स्वतंत्र पिनकोड खोजना
  const exactPinMatch = cleanTxt.match(/(?<!\d)\d{6}(?!\d)/g);
  const badPinMatch = cleanTxt.match(/(?<!\d)\d{5}(?!\d)|(?<!\d)\d{7}(?!\d)/g);

  let hasPinCode = exactPinMatch !== null && exactPinMatch.length > 0;
  let isPinIncorrect = !hasPinCode && (badPinMatch !== null && badPinMatch.length > 0);

  let fingerprint = "";
  if (hasValidPhone && hasPinCode) {
    fingerprint = `${phoneMatches[0]}_${exactPinMatch[0]}`;
    return { isAddress: true, missing: 'none', isPlainMedia: false, cleanText: cleanTxt, fingerprint: fingerprint };
  } else if (hasValidPhone && (!hasPinCode || isPinIncorrect)) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false, cleanText: cleanTxt };
  } else if ((!hasValidPhone || isPhoneIncomplete) && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false, cleanText: cleanTxt };
  }
  
  return { isAddress: false, missing: 'both', isPlainMedia: false, cleanText: cleanTxt };
}

// --- 📦 कतार प्रोसेसिंग इंजन (डबल-वेरिफिकेशन पास होने के बाद चालू होने वाला) ---
async function processFinalOrder(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) {
    await bot.sendMessage(chatId, "⚠️ आपके पास प्रोसेस करने के लिए कोई डेटा नहीं है। कृपया सीधे प्रोडक्ट फोटो और एड्रेस भेजकर शुरुआत करें।", permanentMenuKeyboard);
    return;
  }

  const { userId, resellerName, messages } = session;

  let entireBundleText = "";
  let sampleMsgId = messages[0].originalMsgId;
  for (const m of messages) {
    if (m.text) entireBundleText += m.text + "\n";
  }
  entireBundleText = entireBundleText.trim();

  // वैलिडेशन चेक
  let globalCheck = checkAddressDetails(entireBundleText);
  if (globalCheck.isAddress === false) {
    userSessions.delete(chatId); // 🔄 एरर आते ही तुरंत सेशन खुद ऑटो-कैंसल (रीसेट) करके अगले आर्डर के लिए ऑटो-रेडी करना
    
    let dynamicReason = "";
    if (globalCheck.missing === 'pincode') {
      dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड (Pincode) गायब या गलत है!</b>`;
    } else if (globalCheck.missing === 'phone') {
      dynamicReason = `❌ <b>आपके एड्रेस में मोबाइल नंबर गायब या अधूरा है!</b>`;
    } else if (globalCheck.missing === 'both' || globalCheck.isPlainMedia) {
      dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों गलत या गायब हैं!</b>`;
    }
    
    let alertMsg = `${dynamicReason}\n\n` +
                   `यह आपका आदेश आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी ऑर्डर स्वीकार किया जाएगा।\n\n` +
                   `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                   `<code>${escapeHTML(globalCheck.cleanText || "एड्रेस टेक्स्ट नहीं मिला")}</code>\n\n` +
                   `🚨 <b>आपका ऑर्डर ऑटो-कैंसल कर दिया गया है। बोट अगले ऑर्डर के लिए रेडी है, कृपया मोबाइल नंबर (10 अंक), पिनकोड (6 अंक) और प्रोडक्ट फोटो के साथ पूरा एड्रेस सीधे दोबारा भेजना शुरू करें!</b> 🚨\n\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `👤 <b>ओमप्रकाश</b>\n` +
                   `📞 <code>9376535752</code>\n` +
                   `✈️ @Omprakash9950`;

    try {
      await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', ...permanentMenuKeyboard });
    } catch (e) { console.error("Alert Sender Failed:", e.message); }
    return; 
  }

  // 30 मिनट डुप्लीकेट ऑर्डर लॉक पहरा
  if (globalCheck.isAddress && globalCheck.fingerprint) {
    const lockKey = `${userId}_${globalCheck.fingerprint}`;
    if (recentOrdersMap.has(lockKey)) {
      userSessions.delete(chatId); // 🔄 डुप्लीकेट एरर आते ही तुरंत सेशन खुद ऑटो-कैंसल (रीसेट) करना
      
      let dupAlert = `❌ <b>यह डुप्लीकेट ऑर्डर है!</b>\n\n` +
                     `अगर सच में आपका नया ऑर्डर है तो कृपया 30 मिनट बाद में प्रयास करें।\n\n` +
                     `🚨 <b>आपका पुराना डेटा साफ़ कर दिया गया है। बोट नए ऑर्डर के लिए रेडी है, आप सीधे नया आर्डर भेज सकते हैं।</b>\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b>\n` +
                     `📞 <code>9376535752</code>\n` +
                     `✈️ @Omprakash9950`;
      try {
        await bot.sendMessage(chatId, dupAlert, { parse_mode: 'HTML', ...permanentMenuKeyboard });
      } catch (e) { console.error("Duplicate Alert Failed:", e.message); }
      return; 
    } else {
      recentOrdersMap.set(lockKey, true);
      setTimeout(() => { recentOrdersMap.delete(lockKey); }, 30 * 60 * 1000);
    }
  }

  // सफलतापूर्वक पास होने पर सेशन क्लियर करें (अगले नए ऑर्डर के लिए ऑटो-रेडी) और रीसेलर नेम मैप करें
  userSessions.delete(chatId);
  resellerNamesMap.set(userId, resellerName);

  // स्मार्ट सेपरेटर (जोड़ा बनाना)
  let separatedOrders = [];
  for (const m of messages) {
    if (m.type === 'photo' || m.type === 'video') {
      let addrCheck = checkAddressDetails(m.text);
      if (m.text && m.text.trim().length >= 35 && addrCheck.isAddress) {
        separatedOrders.push({
          text: addrCheck.cleanText,
          media: [m],
          timestamp: m.timestamp,
          originalMsgId: m.originalMsgId,
          isRealOrder: true
        });
      } else {
        let nearestTextMsg = null;
        let minDiff = Infinity;

        for (const tMsg of messages) {
          if (tMsg.type === 'text') {
            let tCheck = checkAddressDetails(tMsg.text);
            if (tCheck.isAddress) {
              let diff = Math.abs(m.timestamp - tMsg.timestamp);
              if (diff < minDiff) {
                minDiff = diff;
                nearestTextMsg = tMsg;
              }
            }
          }
        }

        if (nearestTextMsg) {
          let tCheck = checkAddressDetails(nearestTextMsg.text);
          let existingOrder = separatedOrders.find(o => o.text === tCheck.cleanText);
          if (existingOrder) {
            existingOrder.media.push(m);
          } else {
            separatedOrders.push({
              text: tCheck.cleanText,
              media: [m],
              timestamp: nearestTextMsg.timestamp,
              originalMsgId: nearestTextMsg.originalMsgId,
              isRealOrder: true
            });
          }
        } else {
          if (separatedOrders.length > 0) {
            separatedOrders[separatedOrders.length - 1].media.push(m);
          } else {
            separatedOrders.push({
              text: "",
              media: [m],
              timestamp: m.timestamp,
              originalMsgId: m.originalMsgId,
              isRealOrder: false
            });
          }
        }
      }
    } else if (m.type === 'text') {
      let addrCheck = checkAddressDetails(m.text);
      let isAlreadyIncluded = separatedOrders.some(o => o.text === addrCheck.cleanText);
      
      if (!isAlreadyIncluded) {
        separatedOrders.push({
          text: addrCheck.cleanText,
          media: [],
          timestamp: m.timestamp,
          originalMsgId: m.originalMsgId,
          isRealOrder: addrCheck.isAddress
        });
      }
    }
  }

  for (const order of separatedOrders) {
    globalDeliveryQueue.push({
      userId: userId,
      resellerName: resellerName,
      orderData: order,
      messagesContext: messages
    });
  }

  await bot.sendMessage(chatId, "✅ आपका ऑर्डर सफलतापूर्वक स्वीकार कर लिया गया है और पैकिंग टीम को भेज दिया गया है!\n\n🔄 <b>बोट अगले नए ऑर्डर के लिए तैयार (Ready) है, आप सीधे नया माल भेज सकते हैं।</b>", permanentMenuKeyboard);
  triggerQueueProcessor();
}

// ⚠️ प्रत्येक अलग ऑर्डर के बीच पूरे 15 सेकंड का गैप रखने वाला इंजन ⚠️
async function triggerQueueProcessor() {
  if (isProcessingQueue || globalDeliveryQueue.length === 0) return;
  isProcessingQueue = true;

  while (globalDeliveryQueue.length > 0) {
    const currentTask = globalDeliveryQueue.shift();
    await deliverOrderToAdminGroup(currentTask);

    if (globalDeliveryQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 15000)); 
    }
  }

  isProcessingQueue = false;
}

// एडमिन ग्रुप डिलीवरी इंजन
async function deliverOrderToAdminGroup(task) {
  const { userId, resellerName, orderData, messagesContext } = task;
  const { text: combinedText, media: mediaItems, isRealOrder: initialRealCheck, originalMsgId: orderOriginalMsgId } = orderData;
  const safeResellerName = escapeHTML(resellerName);
  
  let sampleMsgId = orderOriginalMsgId || (mediaItems.length > 0 ? mediaItems[0].originalMsgId : messagesContext[0].originalMsgId);

  let assignedOrderNumStr = null;
  let isRealOrder = false;

  let finalCheck = checkAddressDetails(combinedText);
  if (combinedText.length >= 35 && finalCheck.isAddress) {
    isRealOrder = true;
    let currentCount = resellerOrderCounts.get(userId) || 0;
    currentCount++;
    resellerOrderCounts.set(userId, currentCount);

    let cleanName = resellerName.replace(/[^a-zA-Z0-9]/g, "");
    let namePart = cleanName.substring(0, 2).toUpperCase();
    if (namePart.length < 2) namePart = "OR";
    let idPart = userId.toString().substring(userId.toString().length - 1);

    assignedOrderNumStr = `${namePart}${idPart}-${currentCount.toString().padStart(3, '0')}`;
  }

  if (mediaItems.length === 0 && initialRealCheck && !isRealOrder) return; 
  if (mediaItems.length === 0 && combinedText.length >= 35 && finalCheck.isAddress && !isRealOrder) return; 

  let groupHeaderMsgId = null;
  if (isRealOrder) {
    try {
      let orderHeader = `${escapeHTML(combinedText)}\n\n👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
      let sentHeader = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
      if (sentHeader) {
        groupHeaderMsgId = sentHeader.message_id.toString();
        adminToResellerMsgMap.set(groupHeaderMsgId, sampleMsgId.toString());
      }
    } catch (e) { console.error("Header Send Error:", e.message); }
  }

  for (const mediaItem of mediaItems) {
    try {
      let caption = `👤 ${safeResellerName}\nID: ${userId}`;
      if (assignedOrderNumStr) {
        caption += `\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
      }
      if (!isRealOrder && combinedText !== "") {
        caption += `\n\n📝 विवरण: ${escapeHTML(combinedText)}`;
      }

      let sentMedia = null;
      if (mediaItem.type === 'photo') {
        sentMedia = await bot.sendPhoto(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
      } else if (mediaItem.type === 'video') {
        sentMedia = await bot.sendVideo(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
      }

      if (sentMedia && !isRealOrder) {
        adminToResellerMsgMap.set(sentMedia.message_id.toString(), mediaItem.originalMsgId.toString());
      } else if (sentMedia && isRealOrder && groupHeaderMsgId) {
        adminToResellerMsgMap.set(sentMedia.message_id.toString(), sampleMsgId.toString());
      }
    } catch (e) { console.error("Media Send Error:", e.message); }
  }

  if (mediaItems.length === 0 && combinedText !== "" && !isRealOrder) {
    try {
      let normalText = `👤 ${safeResellerName} (ID: ${userId})\n📝: ${escapeHTML(combinedText)}`;
      let sentTxt = await bot.sendMessage(adminGroupId, normalText, { parse_mode: 'HTML' });
      if (sentTxt) {
        adminToResellerMsgMap.set(sentTxt.message_id.toString(), sampleMsgId.toString());
      }
    } catch (e) { console.error("Pure Text Send Error:", e.message); }
  }

  if (isRealOrder) {
    try {
      await bot.sendMessage(adminGroupId, `🟢 <b>Next Order</b> 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'HTML' });
    } catch (e) { console.error("Divider Error:", e.message); }
  }
}

// --- टेलीग्राम संदेश एवं एडिट नियंत्रक इंजन ---
function handleIncomingMessage(msg, isEdited = false) {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let cleanText = (msg.text || msg.caption || "").trim();
  let currentTimestamp = msg.date;

  // एडमिन ग्रुप रिप्लाई रूट सिस्टम (ग्रुप टू पर्सनल)
  if (chatId === adminGroupId && msg.reply_to_message && !isEdited) {
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
        bot.sendPhoto(targetId, photoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.video) {
        const videoId = msg.video.file_id;
        bot.sendVideo(targetId, videoId, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        return;
      }
      if (msg.text) {
        bot.sendMessage(targetId, cleanText, replyOptions);
        return;
      }
    }
    return;
  }

  // रीसेलर साइड (निजी चैट बटन सिस्टम नियंत्रण)
  if (chatId !== adminGroupId) {
    
    // 🛡️ सख्त साधारण स्टिकर ब्लॉकर
    if (msg.sticker) return; 

    // ✂️ मास्टरस्ट्रोक नियम: 8 अक्षर/शब्द से छोटे सिंगल प्रीमियम कस्टम इमोजी स्टिकर को जड़ से रोकना
    if (cleanText !== "") {
      let isShortMessage = cleanText.length < 8;
      let hasCustomEmoji = false;
      
      if (msg.entities || msg.caption_entities) {
        const targetEntities = msg.entities || msg.caption_entities;
        hasCustomEmoji = targetEntities.some(ent => ent.type === 'custom_emoji');
      }

      // यदि मैसेज 8 अक्षर से छोटा है और उसमें कोई एड्रेस नहीं है, तो उसे सिंगल ग्रुप में जाने से रोकना (ड्राप करना)
      let addrCheck = checkAddressDetails(cleanText);
      if (isShortMessage && !addrCheck.isAddress) {
        return; // मेमोरी में भी जमा नहीं होगा, सीधे रिजेक्ट
      }
      if (hasCustomEmoji && !addrCheck.isAddress) {
        return; // प्रीमियम हरे टिक वाले कस्टम इमोजी को रोकना
      }
    }

    let currentSession = userSessions.get(chatId);

    // बटन कमांड चेक (❌ ऑर्डर रद्द करना)
    if (cleanText === "❌ ऑर्डर रद्द करें / Cancel") {
      userSessions.delete(chatId); // 🧹 मेमोरी से तुरंत पूरा पुराना डेटा क्लियर
      bot.sendMessage(chatId, "🔴 <b>आपका चालू ऑर्डर रद्द (Reset) कर दिया गया है!</b>\n\n🔄 बोट नए ऑर्डर के लिए रेडी है, आप सीधे अपनी नई फोटो और एड्रेस भेजना शुरू कर सकते हैं।", { parse_mode: 'HTML', ...permanentMenuKeyboard });
      return;
    }

    // बटन कमांड चेक (🔴 ऑर्डर पूरा हुआ) -> भूल से दबाने से रोकने के लिए डबल वेरिफिकेशन मोड एक्टिव करना
    if (cleanText === "🔴 ऑर्डर पूरा हुआ") {
      if (!currentSession || currentSession.messages.length === 0) {
        bot.sendMessage(chatId, "⚠️ आपके पास प्रोसेस करने के लिए कोई डेटा नहीं है। कृपया सीधे प्रोडक्ट फोटो और एड्रेस भेजकर शुरुआत करें।", permanentMenuKeyboard);
        return;
      }
      currentSession.status = 'verifying'; // स्टेटस बदलकर पुष्टिकरण मोड पर सेट करना
      bot.sendMessage(chatId, "⚠️ <b>भूल-चूक सुरक्षा लॉक:</b>\n\nक्या आप सच में इस ऑर्डर को फाइनल पैकिंग टीम को भेजना चाहते हैं?\n\nयदि अभी कोई फोटो या सामान बाकी है, तो नीचे 'सामान बाकी है' बटन दबाएं।", confirmationMenuKeyboard);
      return;
    }

    // डबल वेरिफिकेशन: हाँ, फाइनल है (भेजें)
    if (cleanText === "✅ हाँ, FINAL है (भेजें)" || cleanText === "✅ हाँ, फाइनल है (भेजें)") {
      if (currentSession && currentSession.status === 'verifying') {
        processFinalOrder(chatId);
      } else {
        bot.sendMessage(chatId, "कृपया सीधे अपना सामान और एड्रेस भेजना शुरू करें।", permanentMenuKeyboard);
      }
      return;
    }

    // डबल वेरिफिकेशन: नहीं, अभी सामान बाकी है
    if (cleanText === "🔙 नहीं, अभी सामान बाकी है") {
      if (currentSession) {
        currentSession.status = 'collecting'; // वापस नॉर्मल कलेक्शन मोड पर लाना
        bot.sendMessage(chatId, "📥 <b>ऑर्डर मोड यथावत चालू है!</b>\n\nआप अपनी बची हुई तस्वीरें या एड्रेस भेज सकते हैं। पूरा होने पर दोबारा '🔴 ऑर्डर पूरा हुआ' दबाएं।", permanentMenuKeyboard);
      } else {
        bot.sendMessage(chatId, "नया ऑर्डर भेजने के लिए सीधे फोटो और एड्रेस भेजना शुरू करें।", permanentMenuKeyboard);
      }
      return;
    }

    // 🟢 ऑटो-स्टार्ट सेशन: रीसेलर्स के सीधे माल भेजते ही सेशन बैकग्राउंड में खुद चालू हो जाएगा
    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], status: 'collecting' };
      userSessions.set(chatId, currentSession);
    }

    // यदि रीसेलर पुष्टिकरण मोड में होने के बावजूद बटन दबाने के बजाय नया माल भेजने लगे
    if (currentSession.status === 'verifying' && cleanText !== "✅ हाँ, फाइनल है (भेजें)" && cleanText !== "🔙 नहीं, अभी सामान बाकी है") {
      currentSession.status = 'collecting';
    }

    if (isEdited) {
      let existingMsgIdx = currentSession.messages.findIndex(m => m.originalMsgId === msg.message_id);
      if (existingMsgIdx !== -1) {
        currentSession.messages[existingMsgIdx].text = cleanText;
      }
      return;
    }

    // कतार में डेटा सुरक्षित स्टोर करना
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
      bot.sendMessage(chatId, "📸 फोटो प्राप्त हुई! (मेमोरी में सुरक्षित)", permanentMenuKeyboard);
    } else if (msg.video) {
      const videoId = msg.video.file_id;
      currentSession.messages.push({ type: 'video', fileId: videoId, text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
      bot.sendMessage(chatId, "🎥 वीडियो प्राप्त हुई! (मेमोरी में सुरक्षित)", permanentMenuKeyboard);
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
    }
  }
}

bot.on('message', (msg) => {
  handleIncomingMessage(msg, false);
});

bot.on('edited_message', (msg) => {
  handleIncomingMessage(msg, true);
});
