const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी - ऑलवेज एक्टिव मोड
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Omprakash Ji Master Production Mode'); 
});
server.listen(port);

let resellerOrderCounts = new Map(); 
let resellerNamesMap = new Map(); 

function escapeHTML(text) {
  if (!text) return "";
  return text.toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- रोजाना रात 12 बजे ग्रुप में रिपोर्ट और पर्सनल मैसेज भेजना ---
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

// --- ⚙️ सुपर-इंटेलीजेंट एड्रेस डिटेक्टर इंजन (100% सटीक जांच) ---
function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }
  
  let cleanTxt = txt.toString().trim();
  
  // नियम: अगर टेक्स्ट 35 अक्षरों से छोटा है तो सादी फोटो या सामान्य पूछताछ मानेंगे
  if (cleanTxt.length < 35) {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }

  // 1. मोबाइल नंबर खोजना (स्पेस/डैश हटाकर लेकिन साधारण 91 सीरियल नंबर को सुरक्षित रखकर)
  // यह नियम केवल तभी काम करेगा जब 91 या +91 किसी मोबाइल नंबर के ठीक आगे जुड़ा हो, खुले 91 को नहीं छुएगा
  let cleanTextForPhone = cleanTxt.replace(/(?<=\d)[\s-]+(?=\d)/g, ""); 
  const phoneRegex = /(?:(?:\+|0{0,2})91[\s-]*)?([6-9]\d{9})\b|(?<!\d)(\d{10,12})(?!\d)/g;
  
  let phoneMatches = [];
  let match;
  while ((match = phoneRegex.exec(cleanTextForPhone)) !== null) {
    let rawNum = match[1] || match[2];
    if (rawNum) {
      if (rawNum.startsWith('91') && rawNum.length > 10) {
        rawNum = rawNum.substring(2);
      }
      phoneMatches.push(rawNum);
    }
  }

  // 9 अंक या अधूरे नंबर को पकड़ने के लिए सख्त काउंटिंग जांच
  let hasValidPhone = phoneMatches.length > 0;
  let isPhoneIncomplete = false;

  if (!hasValidPhone) {
    let fallbackDigits = cleanTextForPhone.match(/\b\d{6,9}\b/g);
    if (fallbackDigits && fallbackDigits.some(d => d.length === 9 || d.length === 7 || d.length === 8)) {
      isPhoneIncomplete = true;
    }
  }

  // 2. पिनकोड खोजना (पिनकोड हमेशा भारत में 6 अंकों का होता है, 5 या 7 का नहीं)
  let cleanTextForPin = cleanTxt.replace(/(?<=\d)[\s-]+(?=\d)/g, "");
  const exactPinMatch = cleanTextForPin.match(/(?<!\d)\d{6}(?!\d)/g);
  const badPinMatch = cleanTextForPin.match(/(?<!\d)\d{5}(?!\d)|(?<!\d)\d{7}(?!\d)/g);

  let hasPinCode = exactPinMatch !== null && exactPinMatch.length > 0;
  let isPinIncorrect = !hasPinCode && (badPinMatch !== null && badPinMatch.length > 0);

  // अंतिम निर्णय लॉजिक
  if (hasValidPhone && hasPinCode) {
    return { isAddress: true, missing: 'none', isPlainMedia: false };
  } else if (hasValidPhone && (!hasPinCode || isPinIncorrect)) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false };
  } else if ((!hasValidPhone || isPhoneIncomplete) && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false };
  }
  
  return { isAddress: false, missing: 'both', isPlainMedia: false };
}

// --- 📦 मास्टर कतार प्रोसेसिंग इंजन (फॉरवर्ड ऑर्डर सेपरेटर के साथ) ---
async function processUserSession(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) return;

  const { userId, resellerName, messages } = session;
  userSessions.delete(chatId); 

  resellerNamesMap.set(userId, resellerName);
  const safeResellerName = escapeHTML(resellerName);

  // 💡 बड़ी समस्या का हल: एक साथ फॉरवर्ड किए गए ऑर्डर्स को अलग-अलग टुकड़ों में बांटना
  let separatedOrders = [];

  for (const m of messages) {
    if (m.type === 'photo' || m.type === 'video') {
      let addrCheck = checkAddressDetails(m.text);
      
      // अगर इस विशिष्ट फोटो/वीडियो के टेक्स्ट में ही पूरा एड्रेस या अधूरा एड्रेस है
      if (m.text && m.text.trim().length >= 35) {
        separatedOrders.push({
          text: m.text.trim(),
          media: [m],
          addrCheck: addrCheck
        });
      } else {
        // अगर यह सादी फोटो है बिना एड्रेस के, तो इसे पिछले खुले ऑर्डर में या नए सादे मीडिया में डालें
        if (separatedOrders.length > 0) {
          separatedOrders[separatedOrders.length - 1].media.push(m);
        } else {
          separatedOrders.push({
            text: "",
            media: [m],
            addrCheck: addrCheck
          });
        }
      }
    } else if (m.type === 'text') {
      let addrCheck = checkAddressDetails(m.text);
      // सादा टेक्स्ट मैसेज है
      separatedOrders.push({
        text: m.text.trim(),
        media: [],
        addrCheck: addrCheck
      });
    }
  }

  // प्रत्येक अलग किए गए ऑर्डर को एक-एक करके प्रोसेस और चेक करना
  for (const order of separatedOrders) {
    let combinedText = order.text;
    let mediaItems = order.media;
    let addrCheck = order.addrCheck;
    let sampleMsgId = mediaItems.length > 0 ? mediaItems[0].originalMsgId : messages[0].originalMsgId;

    // अगर इस स्वतंत्र ऑर्डर में फोटो है और एड्रेस अधूरा निकला -> ब्लॉक करें और रीसेलर को तुरंत अलर्ट दें
    if (mediaItems.length > 0 && !addrCheck.isPlainMedia && addrCheck.isAddress === false) {
      let dynamicReason = "";
      if (addrCheck.missing === 'pincode') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड (Pincode) गायब या गलत (जैसे 5 अंक का) है!</b>`;
      } else if (addrCheck.missing === 'phone') {
        dynamicReason = `❌ <b>आपके एड्रेस में मोबाइल नंबर गायब या अधूरा (जैसे 9 अंक का) है!</b>`;
      } else if (addrCheck.missing === 'both') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों गलत या गायब हैं!</b>`;
      }
      
      let alertMsg = `${dynamicReason}\n\n` +
                     `यह आपका ऑर्डर आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी सही नहीं है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी ऑर्डर स्वीकार किया जाएगा।\n\n` +
                     `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                     `<code>${escapeHTML(combinedText)}</code>\n\n` +
                     `🚨 <b>कृपया मोबाइल नंबर (10 अंक), पिनकोड (6 अंक) और प्रोडक्ट फोटो के साथ पूरा एड्रेस एक साथ दोबारा भेजें!</b> 🚨\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b> | 📞 <code>9376535752</code>`;

      try {
        await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', reply_to_message_id: sampleMsgId });
      } catch (e) { console.error("Alert Sender Failed:", e.message); }
      
      continue; // ⛔ अधूरा ऑर्डर यहीं रुक गया! अगले ऑर्डर पर बढ़ें, ग्रुप में कुछ नहीं जाएगा।
    }

    // वैध ऑर्डर नंबरिंग जनरेशन
    let assignedOrderNumStr = null;
    let isRealOrder = false;

    if (mediaItems.length > 0 && combinedText.length >= 35 && addrCheck.isAddress) {
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

    // 1. एड्रेस मैसेज ग्रुप में डिलीवर करना (ID मैपिंग के साथ)
    let groupHeaderMsgId = null;
    if (isRealOrder) {
      try {
        let orderHeader = `${escapeHTML(combinedText)}\n\n👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
        let sentHeader = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
        if (sentHeader) {
          groupHeaderMsgId = sentHeader.message_id.toString();
          // 💡 पक्का रिप्लाई सुधार: ग्रुप के एड्रेस वाले मैसेज की आईडी को रीसेलर के एड्रेस वाले मैसेज से मैप करना
          adminToResellerMsgMap.set(groupHeaderMsgId, sampleMsgId.toString());
        }
      } catch (e) { console.error("Header Send Error:", e.message); }
    }

    // 2. प्रोडक्ट फोटो/वीडियो ग्रुप में भेजना
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
          // अगर ऑर्डर असली है, तो फोटो पर होने वाले रिप्लाई को भी एड्रेस रूट पर ही भेजें
          adminToResellerMsgMap.set(sentMedia.message_id.toString(), sampleMsgId.toString());
        }
      } catch (e) { console.error("Media Send Error:", e.message); }
    }

    // 3. बिना फोटो के केवल सादा टेक्स्ट (जरूरी बातचीत) सीधे ग्रुप में भेजना
    if (mediaItems.length === 0 && combinedText !== "") {
      try {
        let normalText = `👤 ${safeResellerName} (ID: ${userId})\n📝: ${escapeHTML(combinedText)}`;
        let sentTxt = await bot.sendMessage(adminGroupId, normalText, { parse_mode: 'HTML' });
        if (sentTxt) {
          adminToResellerMsgMap.set(sentTxt.message_id.toString(), sampleMsgId.toString());
        }
      } catch (e) { console.error("Pure Text Send Error:", e.message); }
    }

    // नेक्स्ट ऑर्डर डिवाइडर लाइन लगाना
    if (isRealOrder) {
      try {
        await bot.sendMessage(adminGroupId, `🟢 <b>Next Order</b> 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'HTML' });
      } catch (e) { console.error("Divider Error:", e.message); }
    }
  }
}

// --- टेलीग्राम संदेश नियंत्रक ---
bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let cleanText = (msg.text || msg.caption || "").trim();

  // 🛠️ एडमिन रिप्लाई रूट सिस्टम (अचूक मैसेज टू मैसेज रिप्लाई)
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

  // ⏳ रीसेलर साइड - सख्त बंडलिंग सुरक्षा प्रणाली
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);
    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], timeoutId: null };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    // मैसेज को कतार (Queue) में सुरक्षित स्टोर करना
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (msg.video) {
      const videoId = msg.video.file_id;
      currentSession.messages.push({ type: 'video', fileId: videoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id });
    }

    // ⏱️ बिल्कुल फिक्स 25 सेकंड का टाइमर लॉक - बिना पूरा हुए मैसेज हिलाएगा भी नहीं बोट
    currentSession.timeoutId = setTimeout(() => {
      processUserSession(chatId);
    }, 25000);
  }
});
