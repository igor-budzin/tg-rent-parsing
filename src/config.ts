import "dotenv/config";

// Telegram API credentials (get from https://my.telegram.org/apps)
export const API_ID = parseInt(process.env.API_ID || "0");
export const API_HASH = process.env.API_HASH || "";

// Telegram Bot token (get from @BotFather)
export const BOT_TOKEN = process.env.BOT_TOKEN || "";

// Postgres connection string
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

// Both web apps are served on one port (Railway sets PORT automatically) and told apart by host
export const PORT = parseInt(process.env.PORT || "3000");
// Public URLs of the user app and the admin app; links sent by the bot point to APP_URL
export const APP_URL = (process.env.APP_URL || `http://app.localhost:${PORT}`).replace(/\/+$/, "");
export const ADMIN_URL = (process.env.ADMIN_URL || `http://admin.localhost:${PORT}`).replace(/\/+$/, "");

// First admin, created on start when there are no admins yet; later admins are added in the admin app
export const ADMIN_LOGIN = process.env.ADMIN_LOGIN || "admin";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// Free trial given once per Telegram user when their first account is created (0 disables)
export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "3");
// Shown to users on the subscription card: how to pay and whom to contact
export const PAYMENT_INSTRUCTIONS = process.env.PAYMENT_INSTRUCTIONS || "";
export const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "";
// Matched posts (they hold phone numbers) are deleted after this many days
export const POST_RETENTION_DAYS = parseInt(process.env.POST_RETENTION_DAYS || "30");

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
// AI requests are spaced to stay under this many per minute; free models allow 20 (0 disables)
export const OPENROUTER_MAX_RPM = parseInt(process.env.OPENROUTER_MAX_RPM || "16");

// Posts the AI failed to parse are retried this many times before being sent unparsed
export const PARSE_RETRY_ATTEMPTS = parseInt(process.env.PARSE_RETRY_ATTEMPTS || "3");
// Delay before the first retry; doubles with each next one (default: 2 minutes)
export const PARSE_RETRY_DELAY_MS = parseInt(process.env.PARSE_RETRY_DELAY_MS || "120000");
