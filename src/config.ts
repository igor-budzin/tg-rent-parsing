import "dotenv/config";

// Telegram API credentials (get from https://my.telegram.org/apps)
export const API_ID = parseInt(process.env.API_ID || "0");
export const API_HASH = process.env.API_HASH || "";

// Telegram Bot token (get from @BotFather)
export const BOT_TOKEN = process.env.BOT_TOKEN || "";

// Postgres connection string for storing bot subscribers
export const DATABASE_URL = process.env.DATABASE_URL || "";

// Channels and keywords are managed in the web UI. These env vars are only used once,
// to seed the database on first start (comma-separated).
export const ENV_CHANNELS: string[] = (process.env.CHANNELS_TO_WATCH || "")
  .split(",")
  .map((ch) => ch.trim())
  .filter(Boolean);

export const ENV_KEYWORDS: string[] = (process.env.KEYWORDS || "")
  .split(",")
  .map((kw) => kw.trim())
  .filter(Boolean);

// Check interval in milliseconds (default: 60 seconds)
export const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

// Web UI for Telegram login (Railway sets PORT automatically)
export const PORT = parseInt(process.env.PORT || "3000");
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
