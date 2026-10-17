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

// OpenRouter for parsing matched posts. Empty key disables AI parsing.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
// Models tried in order: OpenRouter switches to the next one on rate limits and errors (comma-separated)
export const OPENROUTER_MODELS: string[] = (
  process.env.OPENROUTER_MODELS ||
  "google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-super-vl:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Posts the AI failed to parse are retried this many times before being sent unparsed
export const PARSE_RETRY_ATTEMPTS = parseInt(process.env.PARSE_RETRY_ATTEMPTS || "3");
// Delay before the first retry; doubles with each next one (default: 2 minutes)
export const PARSE_RETRY_DELAY_MS = parseInt(process.env.PARSE_RETRY_DELAY_MS || "120000");
