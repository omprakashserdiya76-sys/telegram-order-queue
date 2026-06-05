const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Omprakash Ji Ultimate Master Production Mode v4'); 
});
server.listen(port);

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 
let recentOrdersMap = new Map(); // 30 मिनट डुप्लीकेट लॉक के लिए

let globalDeliveryQueue = [];
let isProcessingQueue = false;

// रीसेलर्स के चालू ऑर्डर सेशन को संभालने के लिए (बटन सिस्टम मेमोरी)
const userSessions = new Map();
const adminToResellerMsgMap = new Map();

// स्टाइलिश/बोल्ड गणितीय नंबरों को नॉर्मल 0-9 में बदलने वाला क्लीनर इंजन
function normalizeStylisedText(text) {
  if (!text) return "";
  let str = text.toString();
  
  const stylishNumbers = {
    '𝟬': '0', '𝟭': '1', '𝟮': '2', '𝟯': '3', '𝟰': '4', '𝟱': '5', '𝟲': '6', '𝟳': '7', '𝟴': '8', '𝟵': '9',
    '𝟶': '0', '𝟷': '1', '𝟸': '2', '𝟹': '3', '𝟺': '4', '𝟻': '5', '𝟼': '6', '𝟽': '7', '𝟾': '8', '𝟿': '9',
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
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [[{ text: "🟢 नया ऑर्डर भेजें" }]],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const sessionMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "🔴 ऑर्डर पूरा हुआ" }],
      [{ text: "❌ ऑर्डर रद्द करें / Cancel" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// --- रोजाना रात 12 बजे ग्रुप में रिपोर्ट (शब्द सुधार) और पर्सनल मैसेज भेजना ---
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
          reportText += `👤 <b>${safeName}</b> (ID: ${userId}) — कुल <b>ऑर्डर</b>: <b>${count}</b>\n`;
          
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

// --- ⚙️ सुधरा हुआ अचूक एड्रेस डिटेक्टर इंजन (मकान नंबर और 2 मोबाइल नंबर से सुरक्षित) ---
function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") {
    return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: "" };
  }
  
  let cleanTxt = normalizeStylisedText(txt).trim();
  
  if (cleanTxt.length < 35) {
    return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: cleanTxt };
  }

  // शुद्ध मोबाइल नंबर ढूंढना: जो स्वतंत्र रूप से लगातार 10 अंकों का हो और 6-9 से शुरू हो
  // यह मकान नंबर (3/4, 252/14A) या पैसों के हिसाब को पूरी तरह अनदेखा कर देगा
  const phoneRegex = /(?<!\d)(?:91)?[6-9]\d{9}(?!\d)/g;
  let phoneMatches = [];
  let match;
  
  // बिना स्पेस-डैश हटाए सीधे शुद्ध 10 अंकों को खोजना ताकि मकान नंबर से टकराव न हो
  while ((match = phoneRegex.exec(cleanTxt)) !== null) {
    let rawNum = match[0];
    if (rawNum.startsWith('91') && rawNum.length > 10) {
      rawNum = rawNum.substring(2);
    }
    if (rawNum.length === 10) {
      phoneMatches.push(rawNum);
    }
  }

  // यदि सीधे नहीं मिला, तो एक बार सुरक्षित क्लीनिंग करके चेक करना (डैश हटाने पर)
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

  // 1 शुद्ध नंबर हो या 2 अलग-अलग शुद्ध मोबाइल नंबर हों, बोट इसे परफेक्ट पास मानेगा
  let hasValidPhone = phoneMatches.length > 0;
  let isPhoneIncomplete = false;

  // केवल तभी अधूरा मानेंगे जब पूरे एड्रेस में एक भी सही 10 अंकों का नंबर न हो और कोई 7-9 अंकों की गलत सीरीज हो
  if (!hasValidPhone) {
    let fallbackDigits = cleanTxt.match(/(?<!\d)[6-9]\d{5,8}(?!\d)/g);
    if (fallbackDigits && fallbackDigits.some(d => d.length === 9 || d.length === 7 || d.length === 8)) {
      isPhoneIncomplete = true;
    }
  }

  // पिनकोड खोजना (सिर्फ शुद्ध 6 अंकों का स्वतंत्र नंबर)
  const exactPinMatch = cleanTxt.match(/(?<!\d)\d{6}(?!\d)/g);
  const badPinMatch = cleanTxt.match(/(?<!\d)\d{5}(?!\d)|(?<!\d)\d{7}(?!\d)/g);

  let hasPinCode = exactPinMatch !== null && exactPinMatch.length > 0;
  let isPinIncorrect = !hasPinCode && (badPinMatch !== null && badPinMatch.length > 0);

  let fingerprint = "";
  if (hasValidPhone && hasPinCode) {
    // डुप्लीकेट लॉक के लिए पहले सही नंबर और पिनकोड का जोड़ा बनाना
    fingerprint = `${phoneMatches[0]}_${exactPinMatch[0]}`;
    return { isAddress: true, missing: 'none', isPlainMedia: false, cleanText: cleanTxt, fingerprint: fingerprint };
  } else if (hasValidPhone && (!hasPinCode || isPinIncorrect)) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false, cleanText: cleanTxt };
  } else if ((!hasValidPhone || isPhoneIncomplete) && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false, cleanText: cleanTxt };
  }
  
  return { isAddress: false, missing: 'both', isPlainMedia: false, cleanText: cleanTxt };
}

// --- 📦 कतार प्रोसेसिंग इंजन (बटन दबाने पर चालू होने वाला) ---
async function processFinalOrder(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) {
    await bot.sendMessage(chatId, "⚠️ आपके पास प्रोसेस करने के लिए कोई डेटा नहीं है। कृपया '🟢 नया ऑर्डर भेजें' दबाकर शुरुआत करें।", mainMenuKeyboard);
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
    let dynamicReason = "";
    if (globalCheck.missing === 'pincode') {
      dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड (Pincode) गायब या गलत है!</b>`;
    } else if (globalCheck.missing === 'phone') {
      dynamicReason = `❌ <b>आपके एड्रेस में मोबाइल नंबर गायब या अधूरा है!</b>`;
    } else if (globalCheck.missing === 'both' || globalCheck.isPlainMedia) {
      dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों गलत या गायब हैं!</b>`;
    }
    
    let alertMsg = `${dynamicReason}\n\n` +
                   `यह आपका ऑर्डर आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी ऑर्डर स्वीकार किया जाएगा।\n\n` +
                   `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                   `<code>${escapeHTML(globalCheck.cleanText || "एड्रेस टेक्स्ट नहीं मिला")}</code>\n\n` +
                   `🚨 <b>कृपया मोबाइल नंबर (10 अंक), पिनकोड (6 अंक) और प्रोडक्ट फोटो के साथ पूरा एड्रेस एक साथ दोबारा भेजें!</b> 🚨\n\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `👤 <b>ओमप्रकाश</b>\n` +
                   `📞 <code>9376535752</code>\n` +
                   `✈️ @Omprakash9950`;

    try {
      await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', reply_to_message_id: sampleMsgId });
    } catch (e) { console.error("Alert Sender Failed:", e.message); }
    return; 
  }

  // 30 मिनट डुप्लीकेट ऑर्डर लॉक पहरा
  if (globalCheck.isAddress && globalCheck.fingerprint) {
    const lockKey = `${userId}_${globalCheck.fingerprint}`;
    if (recentOrdersMap.has(lockKey)) {
      let dupAlert = `❌ <b>यह डुप्लीकेट ऑर्डर है!</b>\n\n` +
                     `अगर सच में आपका ऑर्डर है तो कृपया 30 मिनट बाद में प्रयास करें।\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b>\n` +
                     `📞 <code>9376535752</code>\n` +
                     `✈️ @Omprakash9950`;
      try {
        await bot.sendMessage(chatId, dupAlert, { parse_mode: 'HTML', reply_to_message_id: sampleMsgId });
      } catch (e) { console.error("Duplicate Alert Failed:", e.message); }
      return; 
    } else {
      recentOrdersMap.set(lockKey, true);
      setTimeout(() => { recentOrdersMap.delete(lockKey); }, 30 * 60 * 1000);
    }
  }

  // सफलतापूर्वक पास होने पर सेशन क्लियर करें और रीसेलर नेम मैप करें
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

  // रीसेलर को सफलता का संदेश और वापस होम कीबोर्ड देना
  await bot.sendMessage(chatId, "✅ आपका ऑर्डर सफलतापूर्वक स्वीकार कर लिया गया है और पैकिंग टीम को भेज दिया गया है!", mainMenuKeyboard);

  triggerQueueProcessor();
}

// ⚠️ प्रत्येक अलग ऑर्डर के बीच पूरे 15 सेकंड का गैप रखने वाला इंजन ⚠️
async function triggerQueueProcessor() {
  if (isProcessingQueue || globalDeliveryQueue.length === 0) return;
  isProcessingQueue = true;

  while (globalDeliveryQueue.length > 0) {
    const currentTask = globalDeliveryQueue.shift();
    await deliverOrderToAdminGroup(currentTask);

    // यदि कतार में और भी ऑर्डर्स बचे हैं, तो पूरे 15 सेकंड (15000ms) का कड़ा विराम लें
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
    
    // 🛡️ सख्त स्टिकर एवं प्रीमियम कस्टम इमोजी ब्लॉकर पहरा
    if (msg.sticker) return; // साधारण बड़े स्टिकर ब्लॉक

    // टेलीग्राम प्रीमियम कस्टम इमोजी (जैसे बड़ा हरा टिक सिंबल) आते ही संदेश को जड़ से गायब करना
    if (msg.entities || msg.caption_entities) {
      const targetEntities = msg.entities || msg.caption_entities;
      const hasCustomEmoji = targetEntities.some(ent => ent.type === 'custom_emoji');
      if (hasCustomEmoji) {
        return; // हरा टिक मार्क आते ही यहीं रोक देगा, मेमोरी में भी सेव नहीं करेगा
      }
    }

    let currentSession = userSessions.get(chatId);

    // बटन कमांड चेक
    if (cleanText === "🟢 नया ऑर्डर भेजें") {
      userSessions.set(chatId, { userId: chatId, resellerName: resellerName, messages: [] });
      bot.sendMessage(chatId, "📥 **ऑर्डर मोड चालू हो गया है!**\n\nअब आप बिना किसी समय की पाबंदी के तसल्ली से अपना पूरा एड्रेस और प्रोडक्ट की फोटो/वीडियो भेजें।\n\nसब कुछ भेजने के बाद नीचे दिए गए **'🔴 ऑर्डर पूरा हुआ'** बटन पर क्लिक करें।", sessionMenuKeyboard);
      return;
    }

    if (cleanText === "❌ ऑर्डर रद्द करें / Cancel") {
      userSessions.delete(chatId); // 🧹 मेमोरी से पूरा पुराना डेटा तुरंत क्लियर
      bot.sendMessage(chatId, "🔴 <b>आपका ऑर्डर सफलतापूर्वक कैंसल (रद्द) हो गया है!</b>\n\n🔄 नया ऑर्डर फिर से भेजने के लिए कृपया नीचे दिए गए <b>'🟢 नया ऑर्डर भेजें'</b> बटन पर क्लिक करें।", { parse_mode: 'HTML', ...mainMenuKeyboard });
      return;
    }

    if (cleanText === "🔴 ऑर्डर पूरा हुआ") {
      processFinalOrder(chatId);
      return;
    }

    // अगर कोई रीसेलर बिना बटन दबाए सीधा माल भेजता है
    if (!currentSession) {
      bot.sendMessage(chatId, "⚠️ कृपया ऑर्डर भेजने के लिए पहले नीचे दिए गए **'🟢 नया ऑर्डर भेजें'** बटन पर क्लिक करें!", mainMenuKeyboard);
      return;
    }

    // एडिटेड मैसेज को संभालने का विशेष लॉजिक
    if (isEdited) {
      let existingMsgIdx = currentSession.messages.findIndex(m => m.originalMsgId === msg.message_id);
      if (existingMsgIdx !== -1) {
        currentSession.messages[existingMsgIdx].text = cleanText;
      }
      return;
    }

    // सामान्य रूप से कतार में स्टोर करना
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
    } else if (msg.video) {
      const videoId = msg.video.file_id;
      currentSession.messages.push({ type: 'video', fileId: videoId, text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, timestamp: currentTimestamp, originalMsgId: msg.message_id });
    }
  }
}

// नए मैसेज के लिए लिसनर
bot.on('message', (msg) => {
  handleIncomingMessage(msg, false);
});

// सुधारे गए (Edited) मैसेज के लिए लिसनर
bot.on('edited_message', (msg) => {
  handleIncomingMessage(msg, true);
});
