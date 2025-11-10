import { Telegraf } from "telegraf";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const chatId = process.env.CHAT_ID; // your group chat ID

// Delete messages in group (last 24h)
// 🧹 Wipe function that skips pinned message
async function wipeChat() {
  try {
    // Get chat info to find pinned message
    const chat = await bot.telegram.getChat(chatId);
    const pinnedId = chat.pinned_message?.message_id;

    // Example: delete last 50 messages
    for (let i = 0; i < 50; i++) {
      const messageId = i + 1; // Replace with actual tracked message IDs
      if (messageId === pinnedId) continue; // skip pinned message
      try {
        await bot.telegram.deleteMessage(chatId, messageId);
      } catch {
        // ignore errors if message doesn't exist or can't be deleted
      }
    }

    console.log("Chat wiped successfully (pinned message preserved).");
    await bot.telegram.sendMessage(chatId, "🧹 Chat wiped! (Pinned message untouched)");
  } catch (err) {
    console.error("Error wiping chat:", err);
  }
}

