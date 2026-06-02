const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Exact Reply Mapping Mode'); 
});
server.listen(port);

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 

let globalDeliveryQueue = [];
let isProcessingQueue = false;

function escapeHTML(text) {
  if (!text) return "";
  return text.toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- रोजाना रात 12 बजे ग्रुप में रिपोर्ट भेजना ---
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
          reportText += `👤 <b>${safeName}</b> (ID: ${userId}) — कुल ऑर्डर: <b>${count}</b>\n`;
          
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
const adminToResellerMsgMap = new Map();

// --- ⚙️ एड्रेस डिटेक्टर इंजन ---
function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }
  
  let cleanTxt = txt.toString().trim();
  
  if (cleanTxt.length < 35) {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }

  let textForPhoneCheck = cleanTxt.replace(/(?<=\d)[\s-]+(?=\d)/g, ""); 
  const phoneRegex = /(?:(?:\+|0{0,2})91[\s-]*)?([6-9]\d{9})\b|(?<!\d)(\d{10,12})(?!\d)/g;
  
  let phoneMatches = [];
  let match;
  while ((match = phoneRegex.exec(textForPhoneCheck)) !== null) {
    let rawNum = match[1] || match[2];
    if (rawNum) {
      if (rawNum.startsWith('91') && rawNum.length > 10) {
        rawNum = rawNum.substring(2);
      }
      phoneMatches.push(rawNum);
    }
  }

  let hasValidPhone = phoneMatches.length > 0;
  let isPhoneIncomplete = false;

  if (!hasValidPhone) {
    let fallbackDigits = textForPhoneCheck.match(/\b\d{6,9}\b/g);
    if (fallbackDigits && fallbackDigits.some(d => d.length === 9 || d.length === 7 || d.length === 8)) {
      isPhoneIncomplete = true;
    }
  }

  let cleanTextForPin = cleanTxt.replace(/(?<=\d)[\s-]+(?=\d)/g, "");
  const exactPinMatch = cleanTextForPin.match(/(?<!\d)\d{6}(?!\d)/g);
  const badPinMatch = cleanTextForPin.match(/(?<!\d)\d{5}(?!\d)|(?<!\d)\d{7}(?!\d)/g);

  let hasPinCode = exactPinMatch !== null && exactPinMatch.length > 0;
  let isPinIncorrect = !hasPinCode && (badPinMatch !== null && badPinMatch.length > 0);

  if (hasValidPhone && hasPinCode) {
    return { isAddress: true, missing: 'none', isPlainMedia: false };
  } else if (hasValidPhone && (!hasPinCode || isPinIncorrect)) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false };
  } else if ((!hasValidPhone || isPhoneIncomplete) && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false };
  }
  
  return { isAddress: false, missing: 'both', isPlainMedia: false };
}

// --- 📦 कतार Processing इंजन ---
async function processUserSession(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) return;

  const { userId, resellerName, messages } = session;
  userSessions.delete(chatId); 

  resellerNamesMap.set(userId, resellerName);

  // 🚨 सुरक्षा लॉक: सबसे पहले पूरे बंडल का टेक्स्ट मिलाकर चेक करना
  let entireBundleText = "";
  let sampleMsgId = messages[0].originalMsgId;
  for (const m of messages) {
    if (m.text) entireBundleText += m.text + "\n";
  }
  entireBundleText = entireBundleText.trim();

  let hasAnyMedia = messages.some(m => m.type === 'photo' || m.type === 'video');
  if (hasAnyMedia && entireBundleText.length >= 35) {
    let globalCheck = checkAddressDetails(entireBundleText);
    
    if (globalCheck.isAddress === false) {
      let dynamicReason = "";
      if (globalCheck.missing === 'pincode') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड (Pincode) गायब या गलत (जैसे 5 अंक का) है!</b>`;
      } else if (globalCheck.missing === 'phone') {
        dynamicReason = `❌ <b>आपके एड्रेस में मोबाइल नंबर गायब या अधूरा (जैसे 9 अंक का) है!</b>`;
      } else if (globalCheck.missing === 'both') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों गलत या गायब हैं!</b>`;
      }
      
      let alertMsg = `${dynamicReason}\n\n` +
                     `यह आपका आदेश आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी ऑर्डर स्वीकार किया जाएगा।\n\n` +
                     `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                     `<code>${escapeHTML(entireBundleText)}</code>\n\n` +
                     `🚨 <b>कृपया मोबाइल नंबर (10 अंक), पिनकोड (6 अंक) और प्रोडक्ट फोटो के साथ पूरा एड्रेस एक साथ दोबारा भेजें!</b> 🚨\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b> | 📞 <code>9376535752</code>`;

      try {
        await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', reply_to_message_id: sampleMsgId });
      } catch (e) { console.error("Alert Sender Failed:", e.message); }
      return; 
    }
  }

  // पास होने पर ऑर्डर्स को अलग-अलग टुकड़ों में बांटना
  let separatedOrders = [];

  for (const m of messages) {
    if (m.type === 'photo' || m.type === 'video') {
      let addrCheck = checkAddressDetails(m.text);
      if (m.text && m.text.trim().length >= 35) {
        separatedOrders.push({
          text: m.text.trim(),
          media: [m],
          addrCheck: addrCheck,
          originalMsgId: m.originalMsgId // 💡 असली एड्रेस मैसेज आईडी को स्टोर रखना
        });
      } else {
        if (separatedOrders.length > 0) {
          separatedOrders[separatedOrders.length - 1].media.push(m);
        } else {
          separatedOrders.push({
            text: "",
            media: [m],
            addrCheck: addrCheck,
            originalMsgId: m.originalMsgId
          });
        }
      }
    } else if (m.type === 'text') {
      let addrCheck = checkAddressDetails(m.text);
      separatedOrders.push({
        text: m.text.trim(),
        media: [],
        addrCheck: addrCheck,
        originalMsgId: m.originalMsgId
      });
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

  triggerQueueProcessor();
}

// 15 सेकंड का गैप लूप
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

// एडमिन ग्रुप में सटीक डिलीवरी फंक्शन
async function deliverOrderToAdminGroup(task) {
  const { userId, resellerName, orderData, messagesContext } = task;
  const { text: combinedText, media: mediaItems, addrCheck, originalMsgId: orderOriginalMsgId } = orderData;
  const safeResellerName = escapeHTML(resellerName);
  
  let sampleMsgId = orderOriginalMsgId || (mediaItems.length > 0 ? mediaItems[0].originalMsgId : messagesContext[0].originalMsgId);

  let assignedOrderNumStr = null;
  let isRealOrder = false;

  if (combinedText.length >= 35 && checkAddressDetails(combinedText).isAddress) {
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

  let groupHeaderMsgId = null;
  if (isRealOrder) {
    try {
      let orderHeader = `${escapeHTML(combinedText)}\n\n👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
      let sentHeader = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
      if (sentHeader) {
        groupHeaderMsgId = sentHeader.message_id.toString();
        // 💡 100% पक्का सुधार: ग्रुप के एड्रेस हेडर को सीधे रीसेलर के एड्रेस मैसेज आईडी से लिंक करना
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
        // 💡 सुधार: अगर असली ऑर्डर है, तो फोटो पर होने वाले रिप्लाई को भी रीसेलर के एड्रेस मैसेज पर ही रूट करना
        adminToResellerMsgMap.set(sentMedia.message_id.toString(), sampleMsgId.toString());
      }
    } catch (e) { console.error("Media Send Error:", e.message); }
  }

  if (mediaItems.length === 0 && combinedText !== "") {
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

// --- टेलीग्राम संदेश नियंत्रक ---
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

  // रीसेलर साइड - बंडलिंग सुरक्षा प्रणाली
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);
    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], timeoutId: null };
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

    // ⏱️ रीसेलर लॉक टाइमर पूरे 25 सेकंड (25000ms)
    currentSession.timeoutId = setTimeout(() => {
      processUserSession(chatId);
    }, 25000);
  }
});
