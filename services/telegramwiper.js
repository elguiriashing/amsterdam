import fetch from "node-fetch";
import cron from "node-cron";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastUpdateId = 0; // track the last update to avoid double-processing

// Get pinned message ID
async function getPinnedMessageId() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${TELEGRAM_CHAT_ID}`);
    const data = await res.json();
    return data.result.pinned_message?.message_id || null;
  } catch (err) {
    console.error("❌ Failed to fetch pinned message:", err.message);
    return null;
  }
}

// Delete a single message
async function deleteMessage(message_id) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id }),
    });
  } catch (err) {
    console.error("❌ Failed to delete message:", message_id, err.message);
  }
}

// Fetch updates (messages) since last update_id
async function getUpdates(offset = 0, limit = 100) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&limit=${limit}`);
    const data = await res.json();
    if (!data.ok) return [];
    return data.result;
  } catch (err) {
    console.error("❌ Failed to fetch updates:", err.message);
    return [];
  }
}

// Wipe all messages except pinned
export async function wipeMessages() {
  console.log("🧹 Starting wipe...");
  const pinnedId = await getPinnedMessageId();
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const updates = await getUpdates(offset, 100);
    if (!updates.length) break;

    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) continue;

      if (msg.message_id !== pinnedId) {
        await deleteMessage(msg.message_id);
      }

      offset = update.update_id + 1;
      lastUpdateId = offset;
    }

    if (updates.length < 100) hasMore = false;
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: "✅ Telegram Wiper Bot: All messages wiped (except pinned).",
    }),
  });

  console.log("✅ Wipe complete!");
}

// Handle /wipe command manually
export async function handleWipeCommand() {
  console.log("🧹 /wipe triggered by Telegram");
  await wipeMessages();
}

// Daily auto-wipe at 3am
cron.schedule("0 3 * * *", async () => {
  console.log("🧹 Running daily wipe at 3am...");
  await wipeMessages();
});

// Listen for new Telegram messages to trigger /wipe
async function pollTelegram() {
  try {
    const updates = await getUpdates(lastUpdateId + 1, 100);
    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) continue;

      // Trigger wipe on /wipe command
      if (msg.text?.trim() === "/wipe") {
        await handleWipeCommand();
      }

      lastUpdateId = update.update_id + 1;
    }
  } catch (err) {
    console.error("❌ Telegram polling error:", err.message);
  } finally {
    // Poll every 3 seconds
    setTimeout(pollTelegram, 3000);
  }
}

// Bot online + start polling
export async function startTelegramBot() {
  console.log("🚀 Starting Telegram Wiper Bot...");
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: "✅ Telegram Wiper Bot is online!",
      }),
    });
    pollTelegram(); // start polling for commands
  } catch (err) {
    console.error("❌ Failed to send online message:", err.message);
  }
}
