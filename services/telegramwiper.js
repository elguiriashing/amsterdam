import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_PASS = process.env.ADMIN_PASS; // Access ADMIN_PASS

let nextUpdateOffset = 0; // next offset for getUpdates
let pollingTimeout; // timeout handle for the polling loop
let pollingActive = false;
let isWiping = false;
let botStartTime = Date.now(); // track when bot started
let currentCronJob = null; // store the active cron job for dynamic rescheduling
let autoWipeSchedule = { hours: 48, time: "03:00" }; // default: every 48h at 3am

// In-memory store of recent message IDs per chat (so we can delete them later)
const trackedMessages = new Map(); // chatId -> Array of message IDs
const MAX_TRACKED_PER_CHAT = 500; // safety cap

function trackMessage(chatId, messageId) {
  if (!messageId) return;
  const key = String(chatId);
  if (!trackedMessages.has(key)) {
    trackedMessages.set(key, []);
  }
  const arr = trackedMessages.get(key);
  arr.push(messageId);
  if (arr.length > MAX_TRACKED_PER_CHAT) {
    arr.splice(0, arr.length - MAX_TRACKED_PER_CHAT);
  }
}

function removeTrackedMessage(chatId, messageId) {
  const key = String(chatId);
  const arr = trackedMessages.get(key);
  if (!arr) return;
  const idx = arr.indexOf(messageId);
  if (idx !== -1) arr.splice(idx, 1);
}

function resetTrackedMessages(chatId, pinnedId) {
  const key = String(chatId);
  if (pinnedId) {
    trackedMessages.set(key, [pinnedId]);
  } else {
    trackedMessages.delete(key);
  }
}

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
    removeTrackedMessage(chatId, message_id);
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
  if (isWiping) {
    console.log("Wipe already in progress");
    return;
  }

  console.log("🧹 Starting wipe...");
  isWiping = true;

  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }

  const pinnedId = await getPinnedMessageId();
  const tracked = trackedMessages.get(String(TELEGRAM_CHAT_ID)) ?? [];
  const uniqueIds = [...new Set(tracked)];

  for (const messageId of uniqueIds) {
    if (messageId === pinnedId) continue;
    await deleteMessage(TELEGRAM_CHAT_ID, messageId);
  }

  resetTrackedMessages(TELEGRAM_CHAT_ID, pinnedId);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: "✅ Telegram Wiper Bot: All messages wiped (except pinned).",
      }),
    });
    const data = await res.json();
    if (data.ok) {
      trackMessage(TELEGRAM_CHAT_ID, data.result.message_id);
    }
  } catch (err) {
    console.error("❌ Failed to send wipe confirmation:", err.message);
  }

  console.log("✅ Wipe complete! Restarting polling soon.");
  isWiping = false;
  scheduleNextPoll(1000);
}

function scheduleNextPoll(delayMs = 3000) {
  if (pollingTimeout) clearTimeout(pollingTimeout);
  pollingTimeout = setTimeout(pollTelegram, delayMs);
}

// Handle /wipe command manually
export async function handleWipeCommand() {
  await wipeMessages();
}

// Helper to send a temporary message that self-destructs
async function sendTempMessage(chatId, text, deleteAfterMs = 10000) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const messageId = data.result.message_id;
      trackMessage(chatId, messageId);
      setTimeout(() => deleteMessage(chatId, messageId), deleteAfterMs);
      return messageId;
    }
  } catch (err) {
    console.error("❌ Failed to send temp message:", err.message);
  }
  return null;
}

// Function to update auto-wipe schedule
function updateAutoWipeSchedule(hours, time) {
  // Stop current cron job if it exists
  if (currentCronJob) {
    currentCronJob.stop();
    currentCronJob = null;
  }

  autoWipeSchedule = { hours, time };

  // Parse time (format: "HH:MM" in 24hr)
  const [hour, minute] = time.split(":").map(Number);
  
  // Create cron expression based on hours
  let cronExpression;
  if (hours === 24) {
    // Daily at specified time
    cronExpression = `${minute} ${hour} * * *`;
  } else if (hours === 48) {
    // Every 2 days at specified time (run on even days)
    cronExpression = `${minute} ${hour} */2 * *`;
  } else if (hours === 72) {
    // Every 3 days at specified time
    cronExpression = `${minute} ${hour} */3 * *`;
  } else {
    // For other intervals, use hourly-based cron (less precise but workable)
    const hourInterval = Math.floor(hours);
    cronExpression = `${minute} */${hourInterval} * * *`;
  }

  currentCronJob = cron.schedule(cronExpression, async () => {
    console.log(`🧹 Running auto-wipe (every ${hours}h at ${time})...`);
    await wipeMessages();
  });

  console.log(`✅ Auto-wipe scheduled: every ${hours}h at ${time} (cron: ${cronExpression})`);
}

// Initialize default auto-wipe schedule
updateAutoWipeSchedule(48, "03:00");

// Listen for new Telegram messages to trigger /wipe and /password
async function pollTelegram() {
  if (pollingActive || isWiping) return;
  pollingActive = true;
  try {
    const updates = await getUpdates(nextUpdateOffset, 100);
    if (updates.length) {
      nextUpdateOffset = updates[updates.length - 1].update_id + 1;
    }
    for (const update of updates) {
      const msg = update.message || update.channel_post;
      if (!msg) continue;
      const chatId = msg.chat?.id;
      if (!chatId || String(chatId) !== String(TELEGRAM_CHAT_ID)) continue;

      trackMessage(chatId, msg.message_id);
      if (msg.pinned_message?.message_id) {
        trackMessage(chatId, msg.pinned_message.message_id);
      }

      const text = msg.text?.trim();
      
      // /wipe command
      if (text === "/wipe@Amsterdamnbot") {
        await wipeMessages();
        continue;
      }

      // /password command
      if (text === "/password@Amsterdamnbot") {
        const userChatId = msg.from.id;
        const passwordMessage = `The Admin Dashboard Password is: <code>${ADMIN_PASS}</code>\n\n<i>This message will self-destruct in 60s 💣</i>`;
        const message_id = await sendPrivateMessage(userChatId, passwordMessage);
        if (message_id) {
          setTimeout(() => deleteMessage(userChatId, message_id), 60 * 1000);
        }
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }

      // /status command
      if (text === "/status@Amsterdamnbot") {
        const uptime = Date.now() - botStartTime;
        const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        
        const trackedCount = trackedMessages.get(String(TELEGRAM_CHAT_ID))?.length || 0;
        
        const statusMsg = `
🤖 <b>Bot Status</b>

⏱ <b>Uptime:</b> ${days}d ${hours}h ${minutes}m
📊 <b>Tracked Messages:</b> ${trackedCount}
🧹 <b>Auto-Wipe:</b> Every ${autoWipeSchedule.hours}h at ${autoWipeSchedule.time}
✅ <b>Status:</b> Online & Active
        `.trim();
        
        await sendTempMessage(chatId, statusMsg, 15000);
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }

      // /help command
      if (text === "/help@Amsterdamnbot") {
        const helpMsg = `
🤖 <b>Alex's Bot Commands</b> 🤖

🔑 <b>/password@Amsterdamnbot</b> - Get admin password (DM) 🔑
🧹 <b>/wipe@Amsterdamnbot</b> - Wipe all messages (except pinned) 🧹
📊 <b>/status@Amsterdamnbot</b> - Bot status & stats 📊
🌐 <b>/dashboard@Amsterdamnbot </b> - Admin panel link 🌐
🌍 <b>/website@Amsterdamnbot</b> - Main website link 🌍
⏰ <b>/setautowipe@Amsterdamnbot [hours] [time]</b> - Set auto-wipe schedule ⏰
   Example: <code>/setautowipe 24 14:30</code>

💡 All commands auto-delete after a few seconds. 💡
        `.trim();
        
        await sendTempMessage(chatId, helpMsg, 20000);
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }

      // /dashboard command
      if (text === "/dashboard@Amsterdamnbot") {
        const dashboardMsg = `
🛠 <b>Admin Dashboard</b>

Click here to access the control panel:
👉 https://www.socialclubamsterdam.com/admin

Use <b>/password@Amsterdamnbot</b> to get the login credentials.
        `.trim();
        
        await sendTempMessage(chatId, dashboardMsg, 15000);
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }

      // /website command
      if (text === "/website@Amsterdamnbot") {
        const websiteMsg = `
🌍 <b>Social Club Amsterdam</b>

Main website:
👉 https://www.socialclubamsterdam.com

Check out our live menu, events, and more!
        `.trim();
        
        await sendTempMessage(chatId, websiteMsg, 15000);
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }

      // /setautowipe command
      if (text?.startsWith("/setautowipe@Amsterdamnbot")) {
        const parts = text.split(" ");
        if (parts.length === 3) {
          const hours = parseInt(parts[1]);
          const time = parts[2];
          
          // Validate hours (1-168, which is 1 hour to 1 week)
          if (hours >= 1 && hours <= 168 && /^\d{2}:\d{2}$/.test(time)) {
            updateAutoWipeSchedule(hours, time);
            await sendTempMessage(chatId, `✅ Auto-wipe updated: Every ${hours}h at ${time}`, 10000);
          } else {
            await sendTempMessage(chatId, `❌ Invalid format. Use: <code>/setautowipe [hours] [HH:MM]</code>\nExample: <code>/setautowipe 24 14:30</code>`, 15000);
          }
        } else {
          await sendTempMessage(chatId, `❌ Invalid format. Use: <code>/setautowipe [hours] [HH:MM]</code>\nExample: <code>/setautowipe 24 14:30</code>`, 15000);
        }
        setTimeout(() => deleteMessage(chatId, msg.message_id), 2 * 1000);
        continue;
      }
    }
  } catch (err) {
    console.error("❌ Telegram polling error:", err.message);
  } finally {
    pollingActive = false;
    if (!isWiping) {
      scheduleNextPoll();
    }
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
    const initialUpdates = await getUpdates(null, 1);
    if (initialUpdates.length > 0) {
      nextUpdateOffset = initialUpdates[initialUpdates.length - 1].update_id + 1;
    } else {
      nextUpdateOffset = 0;
    }
    console.log(`Initial nextUpdateOffset set to: ${nextUpdateOffset}`);
    scheduleNextPoll(500);
  } catch (err) {
    console.error("❌ Failed to send online message:", err.message);
  }
}
