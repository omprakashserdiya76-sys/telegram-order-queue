const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.BOT_TOKEN;
const adminGroupId = process.env.ADMIN_GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

// रेंडर वेब सर्वर स्टेबिलिटी
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => { 
  res.end('Engine Active - Strict Bundle & Address Lock Mode'); 
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

// --- ⚙️ अचूक एड्रेस डिटेक्टर इंजन (अक्षरों की लंबाई आधारित) ---
function checkAddressDetails(txt) {
  if (!txt || txt.toString().trim() === "") {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }
  
  let cleanTxt = txt.toString().trim();
  
  // यदि फोटो के साथ लिखा गया टेक्स्ट 35 अक्षरों से कम है, तो यह सादी फोटो/पूछताछ है
  if (cleanTxt.length < 35) {
    return { isAddress: false, missing: 'none', isPlainMedia: true };
  }

  // मोबाइल और पिनकोड की सटीक खोज
  let textForPhoneCheck = cleanTxt.replace(/(?<=\d)\s+(?=\d)/g, "");
  const hasValidPhone = /(?:(?:\+|0{0,2})91[\s-]*)?[6-9]\d{9}\b|\b\d{10,12}\b/.test(textForPhoneCheck);
  const hasPinCode = /\b\d{5,7}\b/.test(cleanTxt);

  if (hasValidPhone && hasPinCode) {
    return { isAddress: true, missing: 'none', isPlainMedia: false };
  } else if (hasValidPhone && !hasPinCode) {
    return { isAddress: false, missing: 'pincode', isPlainMedia: false };
  } else if (!hasValidPhone && hasPinCode) {
    return { isAddress: false, missing: 'phone', isPlainMedia: false };
  }
  
  return { isAddress: false, missing: 'both', isPlainMedia: false };
}

// --- 📦 कतार प्रोसेसिंग इंजन (25 सेकंड बाद एक साथ डिलीवरी) ---
async function processUserSession(chatId) {
  const session = userSessions.get(chatId);
  if (!session || session.messages.length === 0) return;

  const { userId, resellerName, messages } = session;
  userSessions.delete(chatId); // सेशन खाली करें

  resellerNamesMap.set(userId, resellerName);

  // पूरे बंडल में से टेक्स्ट/एड्रेस को ढूंढना
  let combinedText = "";
  let sampleMsgId = null;
  let mediaItems = [];

  for (const m of messages) {
    if (m.text) combinedText += m.text + "\n";
    if (!sampleMsgId) sampleMsgId = m.originalMsgId;
    if (m.type === 'photo' || m.type === 'video') {
      mediaItems.push(m);
    }
  }
  combinedText = combinedText.trim();

  // अगर इस बंडल में कोई भी फोटो/वीडियो मौजूद है, तो एड्रेस चेक होगा
  if (mediaItems.length > 0) {
    let addrCheck = checkAddressDetails(combinedText);

    // 🚨 अगर यह सादी फोटो नहीं है और एड्रेस अधूरा निकला $\rightarrow$ ब्लॉक करें और अलर्ट भेजें
    if (!addrCheck.isPlainMedia && addrCheck.isAddress === false) {
      let dynamicReason = "";
      if (addrCheck.missing === 'pincode') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड (Pincode) मौजूद नहीं है!</b>`;
      } else if (addrCheck.missing === 'phone') {
        dynamicReason = `❌ <b>आपके एड्रेस में मोबाइल नंबर (Mobile Number) मौजूद नहीं है!</b>`;
      } else if (addrCheck.missing === 'both') {
        dynamicReason = `❌ <b>आपके एड्रेस में पिनकोड और मोबाइल नंबर दोनों मौजूद नहीं हैं!</b>`;
      }
      
      let alertMsg = `${dynamicReason}\n\n` +
                     `यह आपका ऑर्डर आगे packing के लिए नहीं जाएगा, क्योंकि इसमें आवश्यक जानकारी गायब है। सही एड्रेस के साथ फिर से फोटो भेजेंगे तभी ऑर्डर स्वीकार किया जाएगा।\n\n` +
                     `📝 <b>आपका भेजा गया अधूरा एड्रेस ये था:</b>\n` +
                     `<code>${escapeHTML(combinedText)}</code>\n\n` +
                     `🚨 <b>कृपया मोबाइल नंबर, पिनकोड और प्रोडक्ट फोटो के साथ पूरा एड्रेस एक साथ दोबारा भेजें!</b> 🚨\n\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `👤 <b>ओमप्रकाश</b> | 📞 <code>9376535752</code>`;

      try {
        await bot.sendMessage(chatId, alertMsg, { parse_mode: 'HTML', reply_to_message_id: sampleMsgId });
      } catch (e) { console.error("Alert Fail:", e.message); }
      
      return; // ⛔ अधूरा ऑर्डर यहीं खत्म! ग्रुप में कुछ भी नहीं जाएगा।
    }
  }

  // --- अगर ऑर्डर वैध है या केवल सादी फोटो/मैसेज है $\rightarrow$ ग्रुप में भेजें ---
  let assignedOrderNumStr = null;
  let isRealOrder = false;

  if (mediaItems.length > 0 && combinedText.length >= 35) {
    let finalCheck = checkAddressDetails(combinedText);
    if (finalCheck.isAddress) {
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
  }

  const safeResellerName = escapeHTML(resellerName);

  // 1. अगर एड्रेस मौजूद है, तो सबसे पहले एड्रेस हेडर भेजें
  if (isRealOrder) {
    try {
      let orderHeader = `${escapeHTML(combinedText)}\n\n👤 ${safeResellerName}\nID: ${userId}\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
      let sentHeader = await bot.sendMessage(adminGroupId, orderHeader, { parse_mode: 'HTML' });
      if (sentHeader && sampleMsgId) {
        adminToResellerMsgMap.set(sentHeader.message_id.toString(), sampleMsgId.toString());
      }
    } catch (e) { console.error("Header Send Error:", e.message); }
  }

  // 2. मीडिया आइटम्स (फोटो/वीडियो) को सीरियल नंबर के साथ ग्रुप में भेजें
  for (const mediaItem of mediaItems) {
    try {
      let caption = `👤 ${safeResellerName}\nID: ${userId}`;
      if (assignedOrderNumStr) {
        caption += `\n📦 <b>ORD # ${assignedOrderNumStr}</b>`;
      }
      // अगर यह सादी फोटो है जिसके साथ छोटा विवरण था
      if (!isRealOrder && combinedText !== "") {
        caption += `\n\n📝 विवरण: ${escapeHTML(combinedText)}`;
      }

      let sentMedia = null;
      if (mediaItem.type === 'photo') {
        sentMedia = await bot.sendPhoto(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
      } else if (mediaItem.type === 'video') {
        sentMedia = await bot.sendVideo(adminGroupId, mediaItem.fileId, { caption: caption, parse_mode: 'HTML' });
      }

      if (sentMedia && mediaItem.originalMsgId) {
        adminToResellerMsgMap.set(sentMedia.message_id.toString(), mediaItem.originalMsgId.toString());
      }
    } catch (e) { console.error("Media Send Error:", e.message); }
  }

  // 3. अगर कोई मीडिया नहीं है, सिर्फ सादा टेक्स्ट मैसेज है (पूछताछ)
  if (mediaItems.length === 0 && combinedText !== "") {
    try {
      let normalText = `👤 ${safeResellerName} (ID: ${userId})\n📝: ${escapeHTML(combinedText)}`;
      let sentTxt = await bot.sendMessage(adminGroupId, normalText, { parse_mode: 'HTML' });
      if (sentTxt && sampleMsgId) {
        adminToResellerMsgMap.set(sentTxt.message_id.toString(), sampleMsgId.toString());
      }
    } catch (e) { console.error("Pure Text Send Error:", e.message); }
  }

  // एंडर डिवाइडर लाइन
  if (isRealOrder) {
    try {
      await bot.sendMessage(adminGroupId, `🟢 <b>Next Order</b> 🟢\n━━━━━━✧━━━━━━`, { parse_mode: 'HTML' });
    } catch (e) { console.error("Divider Error:", e.message); }
  }
}

// --- टेलीग्राम मैसेज रिसीवर ---
bot.on('message', async (msg) => {
  if (!msg.chat || !msg.from) return;

  const chatId = msg.chat.id.toString();
  let resellerName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();
  if (!resellerName) resellerName = "Reseller";

  let cleanText = (msg.text || msg.caption || "").trim();

  // 1. एडमिन रिप्लाई रूट सिस्टम
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

  // 2. रीसेलर साइड फ़िल्टर (सुरक्षित बंडल लॉजिक)
  if (chatId !== adminGroupId) {
    let currentSession = userSessions.get(chatId);
    if (!currentSession) {
      currentSession = { userId: chatId, resellerName: resellerName, messages: [], timeoutId: null };
      userSessions.set(chatId, currentSession);
    }

    if (currentSession.timeoutId) clearTimeout(currentSession.timeoutId);

    // मैसेज को कतार (Queue) के अंदर जमा करना - चाहे वो फोटो हो या सादा टेक्स्ट
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      currentSession.messages.push({ type: 'photo', fileId: photoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (msg.video) {
      const videoId = msg.video.file_id;
      currentSession.messages.push({ type: 'video', fileId: videoId, text: cleanText, originalMsgId: msg.message_id });
    } else if (cleanText !== "") {
      currentSession.messages.push({ type: 'text', text: cleanText, originalMsgId: msg.message_id });
    }

    // ⏱️ सख्त सुरक्षा लॉक: 25 सेकंड तक पूरे डेटा को होल्ड करके रखें, पहले कुछ नहीं भेजना है!
    currentSession.timeoutId = setTimeout(() => {
      processUserSession(chatId);
    }, 25000);
  }
});
