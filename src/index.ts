import {
  API_ID,
  API_HASH,
  BOT_TOKEN,
  DATABASE_URL,
  ADMIN_PASSWORD,
  PORT,
  APP_URL,
  ADMIN_URL,
  TELEGRAM_SESSION_KEY,
} from "./config.js";
import { sessionKeyError } from "./services/session-store.js";
import { log } from "./utils/logger.js";
import { createAndConnectClient, logCurrentUser } from "./services/telegram-client.js";
import { initDb, closeDb } from "./services/db.js";
import { countRecipients, getAudience } from "./services/audience.js";
import { bootstrapAdmin } from "./services/auth.js";
import { setLoggedIn } from "./services/telegram-auth.js";
import { loadWatchConfig, attachClient, getChannelNames } from "./services/watch-config.js";
import { startWebServer } from "./web/server.js";
import { startBotUpdatesPolling } from "./services/bot-updates.js";
import { setupMessageHandler, startChannelPolling, drainPosts } from "./handlers/message-handler.js";
import type http from "node:http";
import type { TelegramClient } from "telegram";
import { startParseRetryQueue } from "./handlers/parse-retry.js";
import { startSubscriptionJobs } from "./jobs/subscription-notices.js";
import { MessageStats } from "./types/index.js";

function validateConfig(): void {
  if (!API_ID || !API_HASH) {
    log("ERROR", "API_ID and API_HASH must be set in .env file");
    log("ERROR", "Get them from https://my.telegram.org/apps");
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

  const keyError = sessionKeyError();
  if (keyError) {
    log("ERROR", keyError);
    process.exit(1);
  }

  for (const [name, value] of [["APP_URL", APP_URL], ["ADMIN_URL", ADMIN_URL]]) {
    try {
      new URL(value);
    } catch {
      log("ERROR", `${name} must be a full URL, e.g. https://app.example.com`);
      process.exit(1);
    }
  }
}

function logConfiguration(): void {
  log("DEBUG", "Configuration loaded", {
    API_ID: API_ID ? `${API_ID} (set)` : "NOT SET",
    API_HASH: API_HASH ? "(set)" : "NOT SET",
    DATABASE_URL: DATABASE_URL ? "(set)" : "NOT SET",
    ADMIN_PASSWORD: ADMIN_PASSWORD ? "(set)" : "NOT SET",
    TELEGRAM_SESSION_KEY: TELEGRAM_SESSION_KEY ? "(set)" : "NOT SET",
    PORT,
    APP_URL,
    ADMIN_URL,
  });
}

async function setupDatabase(): Promise<void> {
  await initDb();
  await bootstrapAdmin();
  await loadWatchConfig();
  log("INFO", `Will notify ${await countRecipients()} user(s) in ${(await getAudience()).length} active account(s)`);
  log("INFO", `Will watch ${getChannelNames().length} channel(s)`, {
    channels: getChannelNames(),
  });
}

function setupPeriodicStatusLog(stats: MessageStats): void {
  setInterval(async () => {
    log("INFO", "Status update", {
      uptime: process.uptime().toFixed(0) + "s",
      messagesReceived: stats.messageCount,
      matchesFound: stats.matchCount,
      recipients: await countRecipients().catch(() => "unknown"),
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
  const server = startWebServer();
  const stats: MessageStats = { messageCount: 0, matchCount: 0 };
  let client: TelegramClient | null = null;
  setupShutdown(server, () => client, stats);
  startSubscriptionJobs();
  startBotUpdatesPolling().catch((err) => {
    log("ERROR", "Bot updates polling stopped", { error: String(err) });
  });

  client = await createAndConnectClient();
  await logCurrentUser(client);
  setLoggedIn(client);

  await attachClient(client);

  setupMessageHandler(client, stats);
  startChannelPolling(client, stats);
  startParseRetryQueue(client);

  log("INFO", "=".repeat(50));
  log("INFO", "NOW WATCHING FOR NEW MESSAGES...");
  log("INFO", "Channels are managed in the admin app, filters by each account in the user app");
  log("INFO", "=".repeat(50));

  setupPeriodicStatusLog(stats);

  await new Promise(() => {});
}

// Docker and Railway stop the container with SIGTERM and kill it about 10 seconds later
const DRAIN_TIMEOUT_MS = 8_000;

function setupShutdown(server: http.Server, getClient: () => TelegramClient | null, stats: MessageStats): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "Shutdown signal received...", { signal });
    log("INFO", "Final statistics", {
      totalMessages: stats.messageCount,
      totalMatches: stats.matchCount,
      uptime: process.uptime().toFixed(0) + "s",
    });
    try {
      server.close();
      // New posts go to the parse queue; the ones being delivered get a few seconds to finish,
      // so recipients aren't left half-sent
      const unfinished = await drainPosts(DRAIN_TIMEOUT_MS);
      if (unfinished > 0) log("WARN", "Shutting down with posts still in progress", { unfinished });
      // Closing the MTProto connection cleanly avoids AUTH_KEY_DUPLICATED when the next
      // instance starts while this one is going away
      await getClient()?.disconnect();
      await closeDb();
      log("INFO", "Disconnected from Telegram. Goodbye!");
      process.exit(0);
    } catch (error) {
      log("ERROR", "Shutdown failed", { error: String(error) });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log("ERROR", "Fatal error occurred", {
    message: err.message,
    name: err.name,
    stack: err.stack,
  });
  process.exit(1);
});
