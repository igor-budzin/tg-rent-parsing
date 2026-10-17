import { TelegramClient, Api } from "telegram";
import { log } from "../utils/logger.js";
import { PARSE_RETRY_ATTEMPTS, PARSE_RETRY_DELAY_MS } from "../config.js";
import { getResolvedChannels } from "../services/watch-config.js";
import { parsePost, aiPausedUntil } from "../services/post-parser.js";
import {
  QueuedPost,
  getDuePosts,
  reschedulePost,
  removeQueuedPost,
} from "../services/parse-queue.js";
import { deliverPost } from "./message-handler.js";

const QUEUE_CHECK_INTERVAL_MS = 30_000;
// Posts handled per check, so a backlog doesn't hit the AI all at once
const QUEUE_BATCH_LIMIT = 5;
// While AI is paused retries wait without using up attempts, but a post isn't held longer than this
const MAX_QUEUE_WAIT_MS = 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The delay doubles with each retry: 2, 4, 8 min… with the default base delay
function retryDelayMs(retry: number): number {
  return PARSE_RETRY_DELAY_MS * 2 ** (retry - 1);
}

async function fetchMessage(
  client: TelegramClient,
  entity: Api.Channel,
  messageId: number
): Promise<Api.Message | null> {
  const [message] = await client.getMessages(entity, { ids: [messageId] });
  return message instanceof Api.Message && message.message ? message : null;
}

async function retryPost(client: TelegramClient, post: QueuedPost): Promise<void> {
  const context = { channel: post.channelTitle, messageId: post.messageId };

  const watched = getResolvedChannels().find((ch) => ch.entity.id.toString() === post.channelId);
  if (!watched) {
    await removeQueuedPost(post.id);
    log("INFO", "Queued post dropped: channel is no longer watched", context);
    return;
  }

  const retry = post.attempts + 1;
  const pausedUntil = aiPausedUntil();
  const waitedTooLong = Date.now() - post.createdAt.getTime() >= MAX_QUEUE_WAIT_MS;
  if (pausedUntil && !waitedTooLong) {
    await reschedulePost(post.id, post.attempts, pausedUntil - Date.now());
    return;
  }

  const message = await fetchMessage(client, watched.entity, post.messageId);
  if (!message) {
    await removeQueuedPost(post.id);
    log("INFO", "Queued post dropped: it was deleted from the channel", context);
    return;
  }

  const isLast = retry >= PARSE_RETRY_ATTEMPTS || waitedTooLong;
  // Skip the AI once the post has waited too long; it's sent raw right away
  const parsed = pausedUntil
    ? null
    : await parsePost(message.message, {
        channel: post.channelTitle,
        messageLink: post.messageLink,
        attempt: retry,
        queueOnFailure: !isLast,
      });

  if (!parsed && !isLast) {
    const delayMs = retryDelayMs(retry + 1);
    await reschedulePost(post.id, retry, delayMs);
    log("INFO", "AI parse retry failed, will try again", {
      ...context,
      retry,
      of: PARSE_RETRY_ATTEMPTS,
      retryInSec: delayMs / 1000,
    });
    return;
  }

  await removeQueuedPost(post.id);
  if (parsed) {
    log("INFO", "Queued post parsed on retry", { ...context, retry });
  } else {
    log("WARN", "AI parse retries exhausted, sending raw post", { ...context, retry, waitedTooLong });
  }
  await deliverPost(
    client,
    message,
    watched.entity,
    post.channelTitle,
    post.keywords,
    post.messageLink,
    parsed
  );
}

async function processQueue(client: TelegramClient): Promise<void> {
  const posts = await getDuePosts(QUEUE_BATCH_LIMIT);
  for (const post of posts) {
    try {
      await retryPost(client, post);
    } catch (error) {
      // Telegram or database trouble: count it as an attempt so a broken post can't loop forever
      const retry = post.attempts + 1;
      log("WARN", "Queued post retry failed", {
        channel: post.channelTitle,
        messageId: post.messageId,
        retry,
        error: errorMessage(error),
      });
      try {
        if (retry >= PARSE_RETRY_ATTEMPTS) {
          await removeQueuedPost(post.id);
          log("ERROR", "Queued post dropped after repeated errors", { link: post.messageLink });
        } else {
          await reschedulePost(post.id, retry, retryDelayMs(retry + 1));
        }
      } catch (dbError) {
        log("WARN", "Could not update parse queue", { error: errorMessage(dbError) });
      }
    }
  }
}

export function startParseRetryQueue(client: TelegramClient): void {
  if (PARSE_RETRY_ATTEMPTS <= 0) {
    log("INFO", "AI parse retries disabled (PARSE_RETRY_ATTEMPTS=0)");
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processQueue(client);
    } catch (error) {
      log("WARN", "Parse queue check failed", { error: errorMessage(error) });
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(tick, QUEUE_CHECK_INTERVAL_MS);
  log("INFO", `AI parse retry queue started: up to ${PARSE_RETRY_ATTEMPTS} retries per post`);
}
