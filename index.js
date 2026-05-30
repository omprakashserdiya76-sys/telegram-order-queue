const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 1. Environment Variables Validation
const token = process.env.BOT_TOKEN;
const spreadsheetId = process.env.SPREADSHEET_ID;
const adminGroupId = process.env.ADMIN_GROUP_ID;

if (!token || !spreadsheetId || !adminGroupId) {
    console.error("❌ Critical Error: Missing required environment variables (BOT_TOKEN, SPREADSHEET_ID, or ADMIN_GROUP_ID).");
    process.exit(1);
}

// 2. Load Google Service Account Credentials from local JSON file
let credentials;
try {
    const credsPath = path.join(__dirname, 'service_account.json');
    if (!fs.existsSync(credsPath)) {
        throw new Error(`service_account.json file not found at ${credsPath}`);
    }
    credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    console.log("✅ Service account credentials loaded successfully from file.");
} catch (error) {
    console.error("❌ Google Credentials Error:", error.message);
    process.exit(1);
}

// 3. Initialize Telegram Bot (Using Webhook to prevent polling conflicts on Render)
const bot = new TelegramBot(token, { polling: true });

// 4. Initialize Google Sheets API
const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

console.log("🚀 Your service is live 🎉");
console.log("=========================================");

// 5. Regular Expressions for Parsing
const resellerRegex = /RESELLER\s*NAME\s*[:-]\s*([^\n]+)/i;
const nameRegex = /NAME\s*[:-]\s*([^\n]+)/i;
const phoneRegex = /(?:PHONE|MOBILE)\s*[:-]\s*([^\n]+)/i;
const pincodeRegex = /PINCODE\s*[:-]\s*([^\n]+)/i;

// Helper function to extract regex matches safely
function extractField(text, regex) {
    const match = text.match(regex);
    return match ? match[1].trim() : '';
}

// Helper function to clean text for sheet writing
function cleanText(text) {
    return text ? text.replace(/\n/g, ' ').trim() : '';
}

// 6. Handle Incoming Messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands or empty messages
    if (!text || text.startsWith('/')) return;

    // Check if the message contains address indicators
    if (text.toUpperCase().includes('NAME') && (text.toUpperCase().includes('PINCODE') || text.toUpperCase().includes('PHONE') || text.toUpperCase().includes('MOBILE'))) {
        
        try {
            // Extract core details using Regex
            let resellerName = extractField(text, resellerRegex);
            const customerName = extractField(text, nameRegex);
            const customerPhone = extractField(text, phoneRegex);
            const pincode = extractField(text, pincodeRegex);

            // Default Reseller Name if missing
            if (!resellerName) {
                resellerName = "Direct Customer";
            }

            // Get Current Date in IST
            const now = new Date();
            const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
            const todayIST = now.toLocaleDateString('en-GB', options); // Format: DD/MM/YYYY

            // Clean the full raw address to put into a single line
            const rawAddressCleaned = cleanText(text);

            console.log(`\n📦 Processing new order from reseller: ${resellerName}`);

            // --- TASK 1: APPEND TO MASTER_SHEET ---
            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'Master_Sheet!A:F',
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[
                        rawAddressCleaned, // Column A: Input Address (Full Raw Text)
                        todayIST,          // Column B: Date
                        resellerName,      // Column C: Reseller Name
                        customerName,      // Column D: Customer Name
                        customerPhone,     // Column E: Phone
                        pincode            // Column F: Pincode
                    ]]
                }
            });
            console.log("✅ Successfully written to Master_Sheet.");

            // --- TASK 2: INCREMENT COUNTER IN ORDER_COUNT ---
            // Step A: Fetch existing data from Order_Count
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'Order_Count!A:C'
            });

            const rows = response.data.values || [];
            let resellerRowIndex = -1;

            // Step B: Search for today's date + reseller match (Skip header row 1)
            for (let i = 1; i < rows.length; i++) {
                if (rows[i][0] === todayIST && rows[i][1]?.toLowerCase() === resellerName.toLowerCase()) {
                    resellerRowIndex = i + 1; // Convert 0-index to 1-based Google Sheet row index
                    break;
                }
            }

            if (resellerRowIndex !== -1) {
                // Scenario A: Combination exists -> Update total order count (Increment by 1)
                const currentCount = parseInt(rows[resellerRowIndex - 1][2] || '0', 10);
                const newCount = currentCount + 1;

                await sheets.spreadsheets.values.update({
                    spreadsheetId: spreadsheetId,
                    range: `Order_Count!C${resellerRowIndex}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[newCount]]
                    }
                });
                console.log(`✅ Incremented order count for ${resellerName} on ${todayIST} to ${newCount}.`);
            } else {
                // Scenario B: Combination does not exist -> Append a brand new row
                await sheets.spreadsheets.values.append({
                    spreadsheetId: spreadsheetId,
                    range: 'Order_Count!A:C',
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[
                            todayIST,     // Column A: Date
                            resellerName, // Column B: Reseller Name
                            1             // Column C: Total Orders (Starts at 1)
                        ]]
                    }
                });
                console.log(`✅ Created fresh record for ${resellerName} on ${todayIST} with count 1.`);
            }

            // --- TASK 3: FORWARD TO ADMIN GROUP ---
            const groupNotificationText = `🔔 *New Order Received*\n\n*Date:* ${todayIST}\n*Reseller:* ${resellerName}\n*Customer:* ${customerName}\n*Phone:* ${customerPhone}\n*Pincode:* ${pincode}\n\n*📋 Raw Details:* \n\`${text}\``;
            
            await bot.sendMessage(adminGroupId, groupNotificationText, { parse_mode: 'Markdown' });
            console.log(`✅ Order notification successfully forwarded to Admin Group (${adminGroupId}).`);

        } catch (sheetError) {
            console.error("❌ Google Sheets Write Error:", sheetError.message || sheetError);
            bot.sendMessage(chatId, "⚠️ सर्वर एरर: ऑर्डर डेटा सुरक्षित करने में समस्या आई। कृपया एडमिन से संपर्क करें।");
        }

    }
});

// Generic process level error handlers to keep bot running
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
