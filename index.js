const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

// 🛡️ टेलीग्राम पोलिंग एरर गार्ड (Conflict Error Handler)
const bot = new TelegramBot(token, { 
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  } 
});

// रेंडर वेब सर्वर स्टेबिलिटी (Render Active Mode)
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Omprakash Ji Syntax Fixed Bulletproof Engine v17'); 
});
server.listen(port);

// 🚨 रेंडर पर पुराना कनेक्शन होने पर बोट को क्रैश होने से बचाने का अचूक चक्रव्यूह 🚨
bot.on('polling_error', (error) => {
  if (error.message && error.message.includes('Conflict')) {
    console.log('🔄 टेलीग्राम कनेक्शन कनवफ्लिक्ट डिटेक्ट हुआ! बोट रिकवरी मोड में है, क्रैश होने से बचा लिया गया है...');
  } else {
    console.error('Polling Error:', error.message);
  }
});

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 
let recentOrdersMap = new Map(); // 30 मिनट डुप्लीकेट लॉक

let globalDeliveryQueue = [];
let isProcessingQueue = false;

// सभी रीसेलर्स की आईडी को लाइफटाइम सुरक्षित रखने का अचूक डेटाबेस (Set)
const activeResellersDatabase = new Set();

const userSessions = new Map();

// 🔄 दोनों तरफ की अचूक रिप्लाई ट्रैकिंग मैपिंग तिजोरी 🔄
const adminToResellerMsgMap = new Map(); // Admin Msg ID -> Reseller Msg ID
const resellerToAdminMsgMap = new Map(); // Reseller Msg ID -> Admin Msg ID
const orderIdToAdminMsgMap = new Map();  // Unique Order Key -> Admin Text Message ID

// 🚀 एडमिन ग्रुप में आए रीसेलर के 'लाइव रिप्लाई' मैसेज की ट्रैकिंग 🚀
const adminLiveReplyToResellerMsgMap = new Map(); // Admin Live Reply Msg ID -> Reseller's original message ID

function normalizeStylisedText(text) {
  if (!text) return "";
  let str = text.toString();
  const stylishNumbers = {
    '𝟬': '0', '𝟭': '1', '𝟮': '2', '𝟯': '3', '𝟰': '4', '𝟱': '5', '𝟲': '6', '𝟳': '7', '𝟴': '8', '𝟵': '9',
    '🟶': '0', '🟷': '1', '🟸': '2', '🟹': '3', '🟺': '4', '🟻': '5', '🟼': '6', '🟽': '7', '🟾': '8', '🟿': '9',
    '⓪': '0', '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9',
    '🄀': '0', '⒈': '1', '⒉': '2', '⒊': '3', '⒋': '4', '⒌': '5', '⒍': '6', '⒎': '7', '⒏': '8', '⒐': '9',
    '⓿': '0', '❶': '1', '❷': '2', '❸': '3', '❹': '4', '❺': '5', '❻': '6', '❼': '7', '❽': '8', '❾': '9'
  };
  return str.split('').map(char => stylishNumbers[char] || char).join('');
}

function escapeHTML(text) {
  if (!text) return "";
  return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const permanentMenuKeyboard = {
  reply_markup: {
    keyboard: [[{ text: "🔴 ऑर्डर पूरा हुआ" }], [{ text: "❌ ऑर्डर रद्द करें / Cancel" }]],
    resize_keyboard: true, one_time_keyboard: false
  }
};

const confirmationMenuKeyboard = {
  reply_markup: {
    keyboard: [[{ text: "✅ हाँ, फाइनल है (भेजें)" }], [{ text: "🔙 नहीं, अभी सामान बाकी है" }]],
    resize_keyboard: true, one_time_keyboard: false
  }
};

// 📊 रोजाना रात 12 बजे ग्रुप में एकदम रिपोर्ट लेआउट 📊
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
          reportText += `👤 <b>नाम:</b> ${escapeHTML(rName)}\n`;
          reportText += `🆔 <b>ID:</b> <code>${userId}</code>\n`;
          reportText += `📦 <b>कुल ऑर्डर:</b> <b>${count}</b>\n`;
          reportText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
          
          try {
            const personalMsg = `नमस्कार! आज आपके कुल <b>${count}</b> ऑर्डर सफलतापूर्वक स्वीकार किए गए हैं\n\n` +
                                `* जिन ऑर्डर्स का COD अमाउंट ₹3900 से अधिक है, उन पर ₹200 शिपिंग charge लगेगा।\n` +
                                `* बाकी सभी ऑर्डर्स पर ₹100 शिपिंग charge लगेगा।\n` +
                                `मार्जिन जुड़वाने के लिए, कृपया शिपिंग charge का भुगतान करें और रसीद मुझे व्हाट्सएप (8890438038)पर भेज दें। धन्यवाद!\n\n` +
                                `हमारे साथ काम करने के लिए धन्यवाद! 🙏`;
            await bot.sendMessage(userId, personalMsg, { parse_mode: 'HTML' });
          } catch (err) { console.error(err.message); }
        }
        reportText += `✅ सभी रीसेलर्स को पर्सनल समरी भेज दी गई है और काउंट रीसेट कर दिया गया है!`;
        try { await bot.sendMessage(adminGroupId, reportText, { parse_mode: 'HTML' }); } catch (e) { console.error(e.message); }
        resellerOrderCounts.clear();
      }
    }
  }, 60000); 
}
startDailyResetTimer();

function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: "" };
  let cleanTxt = normalizeStylisedText(txt).trim();
  if (cleanTxt.length < 35) return { isAddress: false, missing: 'none', isPlainMedia: true, cleanText: cleanTxt };

  const phoneRegex = /(?<!\d)(?:91)?[6-9]\d{9}(?!\d)/g;
  let phoneMatches = []; let match;
  while ((match = phoneRegex.exec(cleanTxt)) !== null) {
    let rawNum = match[0];
    if (rawNum.startsWith('91') && rawNum.length > 10) rawNum = rawNum.substring(2);
    if (rawNum.length === 10) phoneMatches.push(rawNum);
  }

  const exactPinMatch = cleanTxt.match(/(?<!\d)\d{6}(?!\d)/g);
  let hasValidPhone = phoneMatches.length > 0;
  let hasPinCode = exactPinMatch !== null && exactPinMatch.length > 0;

  if (hasValidPhone && hasPinCode) {
    return { isAddress: true, missing: 'none', isPlainMedia: false, cleanText: cleanTxt, fingerprint: `${phoneMatches[0]}_${exactPinMatch[0]}` };
  } else if (hasValidPhone && !hasPinCode) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false, cleanText: cleanTxt };
  } else if (!hasValidPhone && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false, cleanText: cleanTxt };
  }
  return { isAddress: false, missing: 'both', isPlainMedia: false, cleanText: cleanTxt };
}

function countOrdersAndPhotosInSession(session) {
  let orderCount = 0;
  let photoCount = 0;
  
  if (!session || !session.messages) return { orders: 0, photos: 0 };

  session.messages.forEach(m => {
    if (m.type === 'photo') photoCount++;
    if (m.type === 'text' || m.type === 'photo' || m.type === 'video') {
      let textToCheck = m.text || "";
      let check = checkAddressDetails(textToCheck);
      if (check.isAddress) orderCount++;
    }
  });

  if (orderCount === 0 && (photoCount > 0 || session.messages.length > 0)) {
    orderCount = 1;
  }

  return { orders: orderCount, photos: photoCount };
}

async function processFinalOrder(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) {
    await bot.sendMessage(chatId, "⚠️ आपके पास प्रोसेस करने के लिए कोई डेटा नहीं है।", permanentMenuKeyboard);
    return;
  }
  const { userId, resellerName, messages } = session;
  let entireBundleText = messages.map(m => m.text || "").join("\n").trim();

  let globalCheck = checkAddressDetails(entireBundleText);
  
  // ❌ नियम: गलत एड्रेस हेल्पलाइन एरर मैसेज ❌
  if (globalCheck.isAddress === false) {
    userSessions.delete(chatId);
    let dynamicReason = globalCheck.missing === 'pincode' ? `❌ <b>आपके एड्रेस में पिनकोड गायब या गलत है!</b>` : (globalCheck.missing === 'phone' ? `❌ <b>आपके एड्रेस में मोबाइल नंबर गायब या अधूरा है!</b>` : `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों गलत या गायब हैं!</b>`);
    
    let alertMsg = `${dynamicReason}\n\n` +
                   `यह आपका आदेश आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी आदेश स्वीकार किया जाएगा।\n\n` +
                   `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                   `<code>${escapeHTML(globalCheck.cleanText || "एड्रेस नहीं मिला")}</code>\n\n` +
                   `🚨 <b>आपका आदेश ऑटो-कैंसल कर दिया गया है। बोट अगले ऑर्डर के लिए रेडी है, कृपया मोबाइल नंबर (10 अंक), पिनकोड (6 अंक) और प्रोडक्ट फोटो के साथ पूरा एड्रेस सीधे दोबारा भेजना शुरू करें!</b> 🚨\n\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `👤 <b>ओमप्रकाश</b>\n` +
                   `📞 <b>9376535752</b>\n` +
                   `✈️ <b>@Omprakash9950</b>`;
                   
    try { await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', ...permanentMenuKeyboard }); } catch (e) { console.error(e.message); }
    return; 
  }

  // ❌ नियम: डुप्लीकेट ऑर्डर 30 मिनट वाला LOCK ❌
  if (globalCheck.isAddress && globalCheck.fingerprint) {
    const lockKey = `${userId}_${globalCheck.fingerprint}`;
    if (recentOrdersMap.has(lockKey)) {
      userSessions.delete(chatId);
      
      let dupAlert = `❌ <b>यह डुप्लीकेट ऑर्डर है!</b>\n\n` +
                     `अगर सच में आपका नया ऑर्डर है तो कृपया 30 मिनट बाद में प्रयास करें।\n\n` +
                     `🚨 <b>आपका पुराना डेटा साफ़ कर दिया गया है। बोट नए ऑर्डर के लिए रेडी है, आप सीधे नया आर्डर भेज सकते हैं।</b>\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b>\n` +
                     `📞 <b>9376535752</b>\n` +
                     `✈️ <b>@Omprakash9950</b>`;
                     
      try { await bot.sendMessage(chatId, dupAlert, { parse_mode: 'HTML', ...permanentMenuKeyboard }); } catch (e) { console.error(e.message); }
      return; 
    } else {
      recentOrdersMap.set(lockKey, true);
      setTimeout(() => { recentOrdersMap.delete(lockKey); }, 30 * 60 * 1000);
    }
  }

  userSessions.delete(chatId);
  resellerNamesMap.set(userId, resellerName);

  // 📸 स्मार्ट मीडिया ग्रुपिंग इंजन 📸
  let finalMediaItems = [];
  for (const m of messages) {
    if (m.type === 'photo' || m.type === 'video') {
      finalMediaItems.push({ type: m.type, media: m.fileId });
    }
  }

  globalDeliveryQueue.push({
    userId: userId,
    resellerName: resellerName,
    addressText: globalCheck.cleanText,
    mediaItems: finalMediaItems,
    messagesContext: messages
  });

  await bot.sendMessage(chatId, "✅ आपका ऑर्डर सफलतापूर्वक स्वीकार कर लिया गया है और packing टीम को भेज दिया गया है!\n\n🔄 <b>बोट अगले नए ऑर्डर के लिए तैयार (Ready) है, आप सीधे नया माल भेज सकते हैं।</b>", permanentMenuKeyboard);
  triggerQueueProcessor();
}

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

// 📦 एड्रेस ऊपर -> बिना गैप के तुरंत नीचे ग्रिड -> डिवाइडर इंजन 📦
async function deliverOrderToAdminGroup(task) {
  const { userId, resellerName, addressText, mediaItems, messagesContext } = task;
  const safeResellerName = escapeHTML(resellerName);
  let sampleMsgId = messagesContext[0].originalMsgId.toString();

  let currentCount = resellerOrderCounts.get(userId) || 0;
  currentCount++;
  resellerOrderCounts.set(userId, currentCount);

  let cleanName = resellerName.replace(/[^a-zA-Z0-9]/g, "");
  let namePart = cleanName.substring(0, 2).toUpperCase();
  if (namePart.length < 2) namePart = "OR";
  let idPart = userId.toString().substring(userId.toString().length - 1);
  let assignedOrderNumStr = `${namePart}${idPart}-${currentCount.toString().padStart(3, '0')}`;

  let orderHeader = `${escapeHTML(addressText)}\n\n👤 ${safeResellerName}\n🆔 ID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
  let textMessageId = null;
  
  try {
    let sentHeader = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
    if (sentHeader) {
      textMessageId = sentHeader.message_id.toString();
      adminToResellerMsgMap.set(textMessageId, sampleMsgId);
      resellerToAdminMsgMap.set(sampleMsgId, textMessageId);
      
      const uniqueOrderLockKey = `${userId}_${assignedOrderNumStr}`;
      orderIdToAdminMsgMap.set(uniqueOrderLockKey, textMessageId);
    }
  } catch (e) { console.error("Text Head Error:", e.message); }

  if (mediaItems.length > 0 && textMessageId) {
    let chunks = [];
    for (let i = 0; i < mediaItems.length; i += 10) {
      chunks.push(mediaItems.slice(i, i + 10));
    }

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      let currentChunk = chunks[chunkIdx];
      let mediaGroupPayload = currentChunk.map((item, index) => {
        let obj = { type: item.type, media: item.media };
        if (index === 0) {
          obj.caption = `👤 ${safeResellerName}\n📦 <b>ORD # ${assignedOrderNumStr}</b> ${chunks.length > 1 ? `(भाग ${chunkIdx + 1}/${chunks.length})` : ''}`;
          obj.parse_mode = 'HTML';
        }
        return obj;
      });

      try {
        let sentMediaBatch = await bot.sendMediaGroup(adminGroupId, mediaGroupPayload);
        if (sentMediaBatch && sentMediaBatch.length > 0) {
          for (const msgOfBatch of sentMediaBatch) {
            adminToResellerMsgMap.set(msgOfBatch.message_id.toString(), sampleMsgId);
          }
        }
      } catch (e) { console.error("Grid Send Error:", e.message); }
    }
  }

  try {
    await bot.sendMessage(adminGroupId, `🟢 <b>Next Order</b> 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'HTML' });
  } catch (e) { console.error("Divider Error:", e.message); }
}

function handleIncomingMessage(msg, isEdited = false) {
  if (!msg || !msg.chat || !msg.from) return;
  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let cleanText = (msg.text || msg.caption || "").trim();
  let currentTimestamp = msg.date;

  // 📢 रूट १: एडमिन ग्रुप इंजन
  if (chatId === adminGroupId) {
    if (isEdited) return;

    // 🚀 बुलेटप्रूफ ऑल रीसेलर्स ब्रॉडकास्ट इंजन (टेक्स्ट, फोटो, वीडियो तीनों के लिए - फिक्स्ड) 🚀
    if (cleanText && cleanText.toLowerCase().startsWith('@all')) {
      let actualBroadcastNotice = cleanText.substring(4).trim();
      
      let finalBroadCastList = new Set([
        ...activeResellersDatabase,
        ...resellerOrderCounts.keys(),
        ...resellerNamesMap.keys()
      ]);

      if (finalBroadCastList.size > 0) {
        let successCount = 0;
        finalBroadCastList.forEach((targetResellerId) => {
          try {
            if (msg.photo) {
              bot.sendPhoto(targetResellerId, msg.photo[msg.photo.length - 1].file_id, { caption: actualBroadcastNotice });
            } else if (msg.video) {
              bot.sendVideo(targetResellerId, msg.video.file_id, { caption: actualBroadcastNotice });
            } else if (msg.text) {
              if (actualBroadcastNotice.length > 0) {
                bot.sendMessage(targetResellerId, actualBroadcastNotice);
              }
            }
            successCount++;
          } catch (err) { console.error(`Broadcast failed for ${targetResellerId}:`, err.message); }
        });
        bot.sendMessage(adminGroupId, `📢 <b>मल्टीमीडिया ब्रॉडकास्ट सफल!</b>\nयह सूचना मीडिया/टेक्स्ट के साथ सभी <b>${successCount}</b> एक्टिव और रजिस्टर्ड रीसेलर्स को पर्सनल इनबॉक्स में एक साथ भेज दी गई है।`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 🔄 पैकिंग टीम का जवाब (ग्रुप टू पर्सनल - टू-वे रिप्लाई लिंकिंग लॉक) 🔄
    if (msg.reply_to_message) {
      const adminRepliedMsgId = msg.reply_to_message.message_id.toString();
      
      let originalResellerMsgId = adminLiveReplyToResellerMsgMap.get(adminRepliedMsgId);
      
      if (!originalResellerMsgId) {
        originalResellerMsgId = adminToResellerMsgMap.get(adminRepliedMsgId);
      }
      
      const sourceText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
      const idMatch = sourceText.match(/ID:\s*(-?\d+)/);
      
      if (idMatch) {
        const targetId = idMatch[1].trim();
        let replyOptions = {};
        
        if (originalResellerMsgId) {
          replyOptions.reply_to_message_id = parseInt(originalResellerMsgId);
        }

        if (msg.photo) {
          bot.sendPhoto(targetId, msg.photo[msg.photo.length - 1].file_id, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        } else if (msg.video) {
          bot.sendVideo(targetId, msg.video.file_id, { caption: cleanText || "आपका पार्सल पैक हो गया है! 🎉", ...replyOptions });
        } else if (msg.text) {
          bot.sendMessage(targetId, cleanText, replyOptions);
        }
      }
    }
    return;
  }

  // 🔄 रूट २: रीसेलर साइड
  if (chatId !== adminGroupId) {
    if (msg.sticker) return; 

    activeResellersDatabase.add(chatId);

    if (cleanText !== "") {
      if ((cleanText.length < 8 || (msg.entities && msg.entities.some(e => e.type === 'custom_emoji'))) && !checkAddressDetails(cleanText).isAddress) {
        return; 
      }
    }

    let currentSession = userSessions.get(chatId);

    if (cleanText === "❌ ऑर्डर रद्द करें / Cancel") {
      userSessions.delete(chatId);
      bot.sendMessage(chatId, "🔴 <b>आपका चालू ऑर्डर रद्द (Reset) कर दिया गया है!</b>\n\n🔄 बोट नए ऑर्डर के लिए रेडी है, आप सीधे नया माल भेज सकते हैं।", { parse_mode: 'HTML', ...permanentMenuKeyboard });
      return;
    }

    if (cleanText === "🔴 ऑर्डर पूरा हुआ") {
      if (!currentSession || currentSession.messages.length === 0) {
        bot.sendMessage(chatId, "⚠️ आपके पास प्रोसेस करने के लिए कोई डेटा नहीं है।", permanentMenuKeyboard);
        return;
      }
      currentSession.status = 'verifying';
      
      const counts = countOrdersAndPhotosInSession(currentSession);
      
      let verificationMsg = `📝 <b>भूल-चूक सुरक्षा लॉक:</b>\n\n` +
                             `आपके इस स्लॉट में <b>${counts.orders} ऑर्डर (एड्रेस)</b> और <b>${counts.photos} प्रोडक्ट फोटो</b> प्राप्त हुई हैं।\n\n` +
                             `क्या आप सच में इस डेटा को फाइनल पैकिंग टीम को भेजना चाहते हैं?`;
                             
      bot.sendMessage(chatId, verificationMsg, { parse_mode: 'HTML', ...confirmationMenuKeyboard });
      return;
    }

    if (cleanText === "✅ हाँ, फाइनल है (भेजें)") {
      if (currentSession && currentSession.status === 'verifying') { processFinalOrder(chatId); }
      return;
    }

    if (cleanText === "🔙 नहीं, अभी सामान बाकी है") {
      if (currentSession) {
        currentSession.status = 'collecting';
        bot.sendMessage(chatId, "📥 <b>ऑर्डर मोड यथावत चालू है!</b>\n\nआप अपनी बची हुई तस्वीरें या एड्रेस भेज सकते हैं।", permanentMenuKeyboard);
      }
      return;
    }

    if (msg.reply_to_message && !isEdited) {
      const resellerRepliedToId = msg.reply_to_message.message_id.toString();
      let targetAdminMsgId = resellerToAdminMsgMap.get(resellerRepliedToId);

      if (!targetAdminMsgId) {
        const sourceTxt = msg.reply_to_message.text || msg.reply_to_message.caption || "";
        const ordMatch = sourceTxt.match(/ORD\s*#\s*([A-Z0-9-]+)/i);
        if (ordMatch) {
          const foundOrdNum = ordMatch[1].trim();
          targetAdminMsgId = orderIdToAdminMsgMap.get(`${chatId}_${foundOrdNum}`);
        }
      }

      if (targetAdminMsgId) {
        let adminReplyOptions = { reply_to_message_id: parseInt(targetAdminMsgId), parse_mode: 'HTML' };
        let replyNotice = `💬 <b>रीसेलर का जवाब (Reply):</b>\n👤 ${resellerName} (ID: ${chatId})\n\n`;
        
        let sentLiveMsg = null;
        if (msg.photo) {
          sentLiveMsg = await bot.sendPhoto(adminGroupId, msg.photo[msg.photo.length - 1].file_id, { caption: replyNotice + (cleanText || "फोटो भेजा"), ...adminReplyOptions });
        } else if (msg.video) {
          sentLiveMsg = await bot.sendVideo(adminGroupId, msg.video.file_id, { caption: replyNotice + (cleanText || "वीडियो भेजा"), ...adminReplyOptions });
        } else if (cleanText !== "") {
          sentLiveMsg = await bot.sendMessage(adminGroupId, replyNotice + `<code>${escapeHTML(cleanText)}</code>`, adminReplyOptions);
        }

        if (sentLiveMsg) {
          adminLiveReplyToResellerMsgMap.set(sentLiveMsg.message_id.toString(), msg.message_id.toString());
        }
        return; 
      }
    }

    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], status: 'collecting' };
      userSessions.set(chatId, currentSession);
    }
    if (currentSession.status === 'verifying') currentSession.status = 'collecting';

    if (isEdited) {
      let idx = currentSession.messages.findIndex(m => m.originalMsgId === msg.message_id);
      if (idx !== -1) currentSession.messages[idx].text = cleanText;
      return;
    }

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

bot.on('message', (msg) => handleIncomingMessage(msg, false));
bot.on('edited_message', (msg) => handleIncomingMessage(msg, true));
