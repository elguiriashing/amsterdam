// services/telegramwiper.js
import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export default async function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("🚨 Telegram bot token or chat ID missing!");
    return;
  }

  console.log("🚀 Starting Telegram Wiper Bot...");

  // Send startup notification
  await sendTelegramMessage("✅ Telegram Wiper Bot is online!");

  // Polling updates
  let offset = 0;
  setInterval(async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=10&offset=${offset + 1}`
      );
      const data = await res.json();
      if (!data.ok) return;

      for (const update of data.result) {
        offset = update.update_id;

        if (!update.message || !update.message.text) continue;
        const text = update.message.text.trim();

        if (text === "/wipe") {
          await sendTelegramMessage("🧹 Wipe command received! Running wipe...");
          // Add any wipe logic you want here, e.g., clearing DB, logs, etc.
          console.log("🧹 /wipe triggered by Telegram");
        }
      }
    } catch (err) {
      console.error("Telegram polling error:", err);
    }
  }, 3000); // poll every 3s
}

// Helper to send messages
async function sendTelegramMessage(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }
}
