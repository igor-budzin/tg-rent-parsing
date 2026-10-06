import {
  API_ID,
  API_HASH,
  CHANNELS_TO_WATCH,
  KEYWORDS,
  BOT_TOKEN,
  DATABASE_URL,
  ADMIN_PASSWORD,
  PORT,
} from "./config.js";
import { log } from "./utils/logger.js";
import {
  createAndConnectClient,
  logCurrentUser,
  resolveChannels,
} from "./services/telegram-client.js";
import { initDb, closeDb } from "./services/db.js";
import { countActiveSubscribers } from "./services/subscribers.js";
import { setLoggedIn } from "./services/telegram-auth.js";
import { startWebServer } from "./web/server.js";
import { startBotUpdatesPolling } from "./services/bot-updates.js";
import { setupMessageHandler } from "./handlers/message-handler.js";
import { MessageStats } from "./types/index.js";

function validateConfig(): void {
  if (!API_ID || !API_HASH) {
    log("ERROR", "API_ID and API_HASH must be set in .env file");
    log("ERROR", "Get them from https://my.telegram.org/apps");
    process.exit(1);
  }

  if (CHANNELS_TO_WATCH.length === 0) {
    log("ERROR", "CHANNELS_TO_WATCH must be set in .env file (comma-separated)");
    process.exit(1);
  }

  if (KEYWORDS.length === 0) {
    log("ERROR", "KEYWORDS must be set in .env file (comma-separated)");
    process.exit(1);
  }

  if (!BOT_TOKEN) {
    log("ERROR", "BOT_TOKEN must be set in .env file");
    process.exit(1);
  }

  if (!DATABASE_URL) {
    log("ERROR", "DATABASE_URL must be set in .env file");
    process.exit(1);
  }

  if (!ADMIN_PASSWORD) {
    log("ERROR", "ADMIN_PASSWORD must be set in .env file (protects the login web UI)");
    process.exit(1);
  }
}

function logConfiguration(): void {
  log("DEBUG", "Configuration loaded", {
    API_ID: API_ID ? `${API_ID} (set)` : "NOT SET",
    API_HASH: API_HASH ? `${API_HASH.substring(0, 4)}... (set)` : "NOT SET",
    DATABASE_URL: DATABASE_URL ? "(set)" : "NOT SET",
    ADMIN_PASSWORD: ADMIN_PASSWORD ? "(set)" : "NOT SET",
    PORT,
    CHANNELS_TO_WATCH,
    KEYWORDS,
  });

  log("INFO", `Will watch ${CHANNELS_TO_WATCH.length} channel(s)`, {
    channels: CHANNELS_TO_WATCH,
  });
  log("INFO", `Will search for ${KEYWORDS.length} keyword(s)`, {
    keywords: KEYWORDS,
  });
}

async function setupDatabase(): Promise<void> {
  await initDb();
  log("INFO", `Will notify ${await countActiveSubscribers()} subscriber(s)`);
}

function setupPeriodicStatusLog(stats: MessageStats): void {
  setInterval(async () => {
    log("INFO", "Status update", {
      uptime: process.uptime().toFixed(0) + "s",
      messagesReceived: stats.messageCount,
      matchesFound: stats.matchCount,
      subscribers: await countActiveSubscribers().catch(() => "unknown"),
      memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
    });
  }, 60000);
}

async function main(): Promise<void> {
  log("INFO", "=".repeat(50));
  log("INFO", "Telegram Channel Parser Starting...");
  log("INFO", "=".repeat(50));

  logConfiguration();
  validateConfig();

  await setupDatabase();
  startWebServer();
  startBotUpdatesPolling().catch((err) => {
    log("ERROR", "Bot updates polling stopped", { error: String(err) });
  });

  const client = await createAndConnectClient();
  const me = await logCurrentUser(client);
  setLoggedIn([me.firstName, me.lastName].filter(Boolean).join(" ") + (me.username ? ` (@${me.username})` : ""));

  const channelEntities = await resolveChannels(client, CHANNELS_TO_WATCH);

  if (channelEntities.size === 0) {
    log("ERROR", "No valid channels found. Exiting.");
    process.exit(1);
  }

  log("INFO", `Successfully resolved ${channelEntities.size}/${CHANNELS_TO_WATCH.length} channels`);

  const stats: MessageStats = { messageCount: 0, matchCount: 0 };

  setupMessageHandler(client, channelEntities, stats);

  log("INFO", "=".repeat(50));
  log("INFO", "NOW WATCHING FOR NEW MESSAGES...");
  log("INFO", "=".repeat(50));
  log("INFO", `Channels: ${Array.from(channelEntities.values()).map((ch) => ch.title).join(", ")}`);
  log("INFO", `Keywords: ${KEYWORDS.join(", ")}`);
  log("INFO", "Press Ctrl+C to stop");
  log("INFO", "=".repeat(50));

  log("INFO", `Channel Parser Started - Watching: ${CHANNELS_TO_WATCH.length} channel(s), Keywords: ${KEYWORDS.join(", ")}`);

  setupPeriodicStatusLog(stats);

  process.on("SIGINT", async () => {
    log("INFO", "");
    log("INFO", "Shutdown signal received...");
    log("INFO", "Final statistics", {
      totalMessages: stats.messageCount,
      totalMatches: stats.matchCount,
      uptime: process.uptime().toFixed(0) + "s",
    });
    await client.disconnect();
    await closeDb();
    log("INFO", "Disconnected from Telegram. Goodbye!");
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((err) => {
  log("ERROR", "Fatal error occurred", {
    message: err.message,
    name: err.name,
    stack: err.stack,
  });
  process.exit(1);
});
