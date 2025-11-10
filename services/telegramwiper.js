import { Telegraf } from "telegraf";
import cron from "node-cron";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export default async function startTelegramBot() {
  console.log("🚀 Starting Telegram Wiper Bot...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing!");
    return;
  }

  console.log("🔹 TELEGRAM_BOT_TOKEN loaded:", !!BOT_TOKEN);
  console.log("🔹 TELEGRAM_CHAT_ID loaded:", !!CHAT_ID);

  const bot = new Telegraf(BOT_TOKEN);
  let messageIds = new Set();
  let pinnedMessageId = null;

  // -------------------- Startup message --------------------
  async function startupMessage() {
    console.log("📩 Sending startup message...");

    try {
      const chat = await bot.telegram.getChat(CHAT_ID);
      pinnedMessageId = chat.pinned_message?.message_id;

      await bot.telegram.sendMessage(
        CHAT_ID,
        "🤖 Bot is online! Ready to wipe messages (pinned preserved)."
      );

      console.log("✅ Startup message sent. Pinned message ID:", pinnedMessageId);
    } catch (err) {
      console.error("❌ Failed to send startup message:", err);
    }
  }

  // -------------------- Track all new messages --------------------
  bot.on("message", (ctx) => {
    const msgId = ctx.message.message_id;
    if (msgId !== pinnedMessageId) messageIds.add(msgId);
  });

  // -------------------- Wipe function --------------------
  async function wipeChat() {
    if (messageIds.size === 0) {
      console.log("🧹 No messages to delete.");
      return;
    }

    console.log(`🧹 Wiping ${messageIds.size} messages...`);

    for (const id of messageIds) {
      try {
        await bot.telegram.deleteMessage(CHAT_ID, id);
      } catch {
        // Ignore deletion errors
      }
    }

    messageIds.clear();
    console.log("✅ Chat wiped (pinned message untouched).");

    try {
      await bot.telegram.sendMessage(CHAT_ID, "🧹 Chat wiped! (Pinned message untouched)");
    } catch (err) {
      console.error("❌ Failed to send confirmation message:", err);
    }
  }

  // -------------------- Cron schedule --------------------
  // Daily wipe at 03:00 AM
  cron.schedule("0 3 * * *", () => {
    console.log("⏰ Running daily wipe...");
    wipeChat();
  });

  // -------------------- Manual wipe command --------------------
  bot.command("wipe", async (ctx) => {
    if (ctx.chat.id.toString() !== CHAT_ID) return;
    await ctx.reply("Manual wipe initiated...");
    await wipeChat();
  });

  // -------------------- Launch bot --------------------
  try {
    await bot.launch();
    console.log("✅ Bot launched successfully!");
    await startupMessage();
  } catch (err) {
    console.error("❌ Bot failed to launch:", err);
  }

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
