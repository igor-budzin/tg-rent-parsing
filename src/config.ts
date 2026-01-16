import "dotenv/config";

// Telegram API credentials (get from https://my.telegram.org/apps)
export const API_ID = parseInt(process.env.API_ID || "0");
export const API_HASH = process.env.API_HASH || "";

// Your Telegram username or user ID to receive notifications
export const NOTIFY_USER = process.env.NOTIFY_USER || "";

// Telegram Bot token (get from @BotFather)
// If set, notifications will be sent via bot instead of your own account
export const BOT_TOKEN = process.env.BOT_TOKEN || "";

// Your Telegram user ID for bot notifications (get from @userinfobot)
export const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";

// Channels to monitor (usernames without @, or channel IDs)
export const CHANNELS_TO_WATCH: string[] = [
  "x_arenda_kyiv",
  "budzin_test"
  // Add channel usernames here, e.g.:
  // "rental_apartments_moscow",
  // "rent_spb",
];

// Keywords to search for (case-insensitive)
export const KEYWORDS: string[] = [
  "мінська",
  "Мінська",
  "Оболонь",
  // Add your keywords here, e.g.:
  // "2-комнатная",
  // "без комиссии",
  // "от хозяина",
];

// Check interval in milliseconds (default: 60 seconds)
export const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

// Session file path
export const SESSION_FILE = "./session.txt";
