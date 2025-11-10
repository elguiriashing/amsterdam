import fetch from "node-fetch";
import cron from "node-cron";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Get pinned message ID
async function getPinnedMessageId() {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${TELEGRAM_CHAT_ID}`);
  const data = await res.json();
  return data.result.pinned_message?.message_id || null;
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
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&limit=${limit}`);
  const data = await res.json();
  if (!data.ok) return [];
  return data.result;
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

      // Update offset to the last seen update_id + 1
      offset = update.update_id + 1;
    }

    if (updates.length < 100) hasMore = false; // No more updates
  }

  // Notify group (optional)
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: "✅ Telegram Wiper Bot: All messages wiped (except pinned)." }),
  });

  console.log("✅ Wipe complete!");
}

// Manual /wipe command
export async function handleWipeCommand() {
  console.log("🧹 /wipe triggered by Telegram");
  await wipeMessages();
}

// Daily auto-wipe at 3am
cron.schedule("0 3 * * *", async () => {
  console.log("🧹 Running daily wipe at 3am...");
  await wipeMessages();
});

// Bot online message
fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: "✅ Telegram Wiper Bot is online!" }),
});
