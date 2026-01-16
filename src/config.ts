import "dotenv/config";

// Telegram API credentials (get from https://my.telegram.org/apps)
export const API_ID = parseInt(process.env.API_ID || "0");
export const API_HASH = process.env.API_HASH || "";

// Telegram Bot token (get from @BotFather)
export const BOT_TOKEN = process.env.BOT_TOKEN || "";

// Telegram user IDs for notifications (comma-separated, get from @userinfobot)
export const TELEGRAM_USER_IDS: string[] = (process.env.TELEGRAM_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Channels to monitor (comma-separated usernames without @, or channel IDs)
export const CHANNELS_TO_WATCH: string[] = (process.env.CHANNELS_TO_WATCH || "")
  .split(",")
  .map((ch) => ch.trim())
  .filter(Boolean);

// Keywords to search for (comma-separated, case-insensitive)
export const KEYWORDS: string[] = (process.env.KEYWORDS || "")
  .split(",")
  .map((kw) => kw.trim())
  .filter(Boolean);

// Check interval in milliseconds (default: 60 seconds)
export const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

// Session file path
export const SESSION_FILE = "./session.txt";
