import {
  API_ID,
  API_HASH,
  CHANNELS_TO_WATCH,
  KEYWORDS,
  SESSION_FILE,
  BOT_TOKEN,
  TELEGRAM_USER_IDS,
} from "./config.js";
import { log } from "./utils/logger.js";
import { closeReadline } from "./utils/prompt.js";
import {
  createAndConnectClient,
  logCurrentUser,
  resolveChannels,
} from "./services/telegram-client.js";
import { isUsingBot } from "./services/notification.js";
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

  if (TELEGRAM_USER_IDS.length === 0) {
    log("ERROR", "TELEGRAM_USER_IDS must be set in .env file (comma-separated)");
    process.exit(1);
  }
}

function logConfiguration(): void {
  log("DEBUG", "Configuration loaded", {
    API_ID: API_ID ? `${API_ID} (set)` : "NOT SET",
    API_HASH: API_HASH ? `${API_HASH.substring(0, 4)}... (set)` : "NOT SET",
    TELEGRAM_USER_IDS: TELEGRAM_USER_IDS.length > 0 ? TELEGRAM_USER_IDS : "NOT SET",
    CHANNELS_TO_WATCH,
    KEYWORDS,
    SESSION_FILE,
  });

  log("INFO", `Will watch ${CHANNELS_TO_WATCH.length} channel(s)`, {
    channels: CHANNELS_TO_WATCH,
  });
  log("INFO", `Will search for ${KEYWORDS.length} keyword(s)`, {
    keywords: KEYWORDS,
  });
  log("INFO", `Will notify ${TELEGRAM_USER_IDS.length} user(s)`);
}

function setupPeriodicStatusLog(stats: MessageStats): void {
  setInterval(() => {
    log("INFO", "Status update", {
      uptime: process.uptime().toFixed(0) + "s",
      messagesReceived: stats.messageCount,
      matchesFound: stats.matchCount,
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

  const client = await createAndConnectClient();
  await logCurrentUser(client);

  const channelEntities = await resolveChannels(client, CHANNELS_TO_WATCH);

  if (channelEntities.size === 0) {
    log("ERROR", "No valid channels found. Exiting.");
    process.exit(1);
  }

  log("INFO", `Successfully resolved ${channelEntities.size}/${CHANNELS_TO_WATCH.length} channels`);

  closeReadline();
  log("DEBUG", "Readline interface closed");

  const useBot = isUsingBot();
  if (useBot) {
    log("INFO", "Bot notification mode enabled", {
      botTokenSet: !!BOT_TOKEN,
      userCount: TELEGRAM_USER_IDS.length,
    });
  }

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
