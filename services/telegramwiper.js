import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_PASS = process.env.ADMIN_PASS; // Access ADMIN_PASS

let lastUpdateId = 0; // track the last update to avoid double-processing
let pollingTimeout; // To store the timeout ID for pollTelegram

// Function to send a private message to a specific chat ID
async function sendPrivateMessage(chat_id, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        text,
        parse_mode: "HTML",
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    console.log(`✅ Sent private message to ${chat_id}`);
    return data.result.message_id;
  } catch (err) {
    console.error(`❌ Failed to send private message to ${chat_id}:`, err.message);
    return null;
  }
}

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
async function deleteMessage(chatId, message_id) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id }),
    });
  } catch (err) {
    console.error("❌ Failed to delete message:", message_id, err.message);
  }
}

// Fetch updates (messages)
// Allow offset to be explicitly null (or undefined) to fetch all unconfirmed updates from the earliest possible point
async function getUpdates(offset = null, limit = 100) {
  try {
    const url = offset !== null
      ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&limit=${limit}`
      : `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=${limit}`;

    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
      console.error("Telegram API error:", data.description);
      return [];
    }
    return data.result;
  } catch (err) {
    console.error("❌ Failed to fetch updates:", err.message);
    return [];
  }
}

// Wipe all messages except pinned
export async function wipeMessages() {
  console.log("🧹 Starting wipe...");

  clearTimeout(pollingTimeout); // Stop regular polling during wipe

  const pinnedId = await getPinnedMessageId();
  let currentOffset = lastUpdateId + 1; // Start from the last known update ID to avoid re-processing known messages
  let hasMore = true;
  let highestUpdateIdProcessed = lastUpdateId; // Track highest update_id for post-wipe `lastUpdateId`

  while (hasMore) {
    const updates = await getUpdates(currentOffset, 100); // Fetch updates
    if (!updates.length) break;

    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) continue;

      if (msg.message_id !== pinnedId) {
        await deleteMessage(TELEGRAM_CHAT_ID, msg.message_id);
      }
      
      // Update highestUpdateIdProcessed to the latest update_id encountered
      if (update.update_id >= highestUpdateIdProcessed) {
          highestUpdateIdProcessed = update.update_id + 1;
      }
    }
    // Set the offset for the next batch to the update_id + 1 of the last message in the current batch
    if (updates.length > 0) {
      currentOffset = updates[updates.length - 1].update_id + 1;
    }

    if (updates.length < 100) hasMore = false; // No more updates if less than limit
  }

  // After wipe, set the global lastUpdateId to the highest update_id processed by wipeMessages
  // This ensures pollTelegram starts from where wipeMessages left off
  lastUpdateId = highestUpdateIdProcessed;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: "✅ Telegram Wiper Bot: All messages wiped (except pinned).",
    }),
  });

  console.log(`✅ Wipe complete! lastUpdateId set to: ${lastUpdateId}. Restarting polling.`);
  pollTelegram(); // Restart regular polling
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

// Listen for new Telegram messages to trigger /wipe and /password
async function pollTelegram() {
  try {
    const updates = await getUpdates(lastUpdateId + 1, 100); // Fetch updates *after* lastUpdateId
    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) continue;

      // Trigger wipe on /wipe command
      if (msg.text?.trim() === "/wipe") {
        await handleWipeCommand();
      }

      // Send admin password privately on /password command
      if (msg.text?.trim() === "/password") {
        const userChatId = msg.from.id;
        const passwordMessage = `The Admin Dashboard Password is: <code>${ADMIN_PASS}</code>\n\n<i>This message will self-destruct in 60s 💣</i>`;
        const message_id = await sendPrivateMessage(userChatId, passwordMessage);
        if (message_id) {
          setTimeout(() => deleteMessage(userChatId, message_id), 60 * 1000); // 60 seconds
        }
      }

      // Only update lastUpdateId if the current update_id is higher
      // This prevents issues if updates arrive out of order or if wipeMessages resets it
      if (update.update_id + 1 > lastUpdateId) {
        lastUpdateId = update.update_id + 1;
      }
    }
  } catch (err) {
    console.error("❌ Telegram polling error:", err.message);
  } finally {
    pollingTimeout = setTimeout(pollTelegram, 3000); // Store timeout ID
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
    // Initialize lastUpdateId to the highest existing update_id to avoid re-processing old updates
    const initialUpdates = await getUpdates(null, 1); // Get the latest update to initialize lastUpdateId
    if (initialUpdates.length > 0) {
      lastUpdateId = initialUpdates[initialUpdates.length - 1].update_id + 1;
    } else {
      lastUpdateId = 0; // No updates yet, start from 0
    }
    console.log(`Initial lastUpdateId set to: ${lastUpdateId}`);
    pollTelegram(); // start polling for commands
  } catch (err) {
    console.error("❌ Failed to send online message:", err.message);
  }
}
