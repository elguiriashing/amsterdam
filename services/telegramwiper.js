import { Telegraf } from "telegraf";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const chatId = process.env.CHAT_ID; // your group chat ID

// Delete messages in group (last 24h)
async function wipeChat() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;

    // Delete 100 most recent messages
    for (let i = 0; i < 100; i++) {
      await bot.telegram.deleteMessage(chatId, now - i);
    }

    console.log("Chat wiped successfully.");
  } catch (err) {
    console.error("Error wiping chat:", err);
  }
}

// Schedule: every day at 03:00 (server time)
cron.schedule("0 3 * * *", () => {
  wipeChat();
});

bot.launch();
