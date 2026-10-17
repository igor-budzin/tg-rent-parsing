import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { log } from "../utils/logger.js";
import { findMatchingKeywords } from "../utils/keywords.js";
import {
  findWatchedChannel,
  getResolvedChannels,
  roomsMatch,
  floorMatches,
  priceMatches,
} from "../services/watch-config.js";
import { CHECK_INTERVAL_MS, PARSE_RETRY_ATTEMPTS, PARSE_RETRY_DELAY_MS } from "../config.js";
import {
  sendNotification,
  sendPhotoNotification,
  sendAlbumNotification,
} from "../services/notification.js";
import { parsePost, isAiEnabled } from "../services/post-parser.js";
import { enqueuePost } from "../services/parse-queue.js";
import { hasActiveSubscribers } from "../services/subscribers.js";
import { recordPostStat } from "../services/post-stats.js";
import { MessageStats, ParsedPost } from "../types/index.js";

// Max posts fetched per channel per poll
const POLL_BATCH_LIMIT = 100;
// Telegram albums hold up to 10 media, posted as consecutive messages
const MAX_ALBUM_SIZE = 10;

async function downloadAlbumPhotos(
  client: TelegramClient,
  channelEntity: Api.Channel,
  message: Api.Message,
  groupedId: Api.long
): Promise<Buffer[]> {
  // Look around the post itself, so older posts (retried from the parse queue) work too
  const ids = Array.from({ length: MAX_ALBUM_SIZE * 2 - 1 }, (_, i) => message.id - MAX_ALBUM_SIZE + 1 + i);
  const messages = await client.getMessages(channelEntity, { ids });

  const albumMessages = messages.filter((m) => m?.groupedId?.equals(groupedId));
  const photoBuffers: Buffer[] = [];

  for (const albumMsg of albumMessages) {
    if (albumMsg.photo) {
      const buffer = (await client.downloadMedia(albumMsg, {})) as Buffer;
      if (buffer) {
        photoBuffers.push(buffer);
      }
    }
  }

  return photoBuffers;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRICE_PERIODS = { month: " / міс.", day: " / доба" } as const;

function formatParsedCaption(
  parsed: ParsedPost,
  channelTitle: string,
  messageLink: string
): string {
  const lines: string[] = [];
  if (parsed.type === "rent") lines.push("🏠 <b>ОРЕНДА</b>");
  if (parsed.type === "sell") lines.push("🏷 <b>ПРОДАЖ</b>");
  if (parsed.price) {
    const { amount, currency, period } = parsed.price;
    const formatted = amount.toLocaleString("uk-UA");
    lines.push(
      `💰 <b>Ціна:</b> ${formatted} ${escapeHtml(currency)}${period ? PRICE_PERIODS[period] ?? "" : ""}`
    );
  }
  if (parsed.location) lines.push(`📍 <b>Локація:</b> ${escapeHtml(parsed.location)}`);
  if (parsed.rooms) lines.push(`🚪 <b>Кімнат:</b> ${parsed.rooms}`);
  if (parsed.area) lines.push(`📐 <b>Площа:</b> ${parsed.area.toLocaleString("uk-UA")} м²`);
  if (parsed.floor !== null) {
    const total = parsed.totalFloors ? `/${parsed.totalFloors}` : "";
    lines.push(`🏢 <b>Поверх:</b> ${parsed.floor}${total}`);
  }
  if (parsed.contacts.length > 0) {
    lines.push(`📞 <b>Контакти:</b> ${parsed.contacts.map(escapeHtml).join(", ")}`);
  }

  return `${lines.join("\n")}\n\n<b>Канал:</b> ${escapeHtml(channelTitle)}\n${messageLink}`;
}

// Sends the post's photos with the caption, falling back to a text message.
// Returns whether at least one subscriber got it.
async function sendPost(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  caption: string
): Promise<boolean> {
  const groupedId = message.groupedId;

  if (groupedId) {
    try {
      const photoBuffers = await downloadAlbumPhotos(client, channelEntity, message, groupedId);
      if (photoBuffers.length > 1 && (await sendAlbumNotification(photoBuffers, caption))) return true;
      if (photoBuffers.length === 1 && (await sendPhotoNotification(photoBuffers[0], caption))) return true;
    } catch (error) {
      log("ERROR", "Failed to process album", { error });
    }
  } else if (message.photo) {
    try {
      const photoBuffer = (await client.downloadMedia(message, {})) as Buffer;
      if (photoBuffer && (await sendPhotoNotification(photoBuffer, caption))) return true;
    } catch (error) {
      log("ERROR", "Failed to download/send photo", { error });
    }
  }

  return sendNotification(caption);
}

// Unparsed posts are sent as is; parsed ones only when they fit the room, floor and price filters
export async function deliverPost(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  channelTitle: string,
  matchedKeywords: string[],
  messageLink: string,
  parsed: ParsedPost | null
): Promise<void> {
  if (
    parsed &&
    (!roomsMatch(parsed.rooms) || !floorMatches(parsed.floor) || !(await priceMatches(parsed.price)))
  ) {
    log("INFO", "Post skipped: doesn't fit the room/floor/price filter", {
      channel: channelTitle,
      messageId: message.id,
      rooms: parsed.rooms,
      floor: parsed.floor,
      price: parsed.price,
    });
    recordPostStat(channelTitle, "filtered_out");
    return;
  }

  const caption = parsed
    ? formatParsedCaption(parsed, channelTitle, messageLink)
    : `<b>Match found!</b>\n\n<b>Channel:</b> ${channelTitle}\n<b>Keywords:</b> ${matchedKeywords.join(", ")}\n\n${message.message}\n\n${messageLink}`;

  if (await sendPost(client, message, channelEntity, caption)) {
    recordPostStat(channelTitle, "sent");
  }
}

// A post the AI fails to parse goes to the parse queue and is retried later;
// it's sent unparsed only when retries are off or the queue can't be written
async function handleNotification(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  channelTitle: string,
  matchedKeywords: string[],
  messageLink: string
): Promise<void> {
  const deliver = (parsed: ParsedPost | null) =>
    deliverPost(client, message, channelEntity, channelTitle, matchedKeywords, messageLink, parsed);

  if (!isAiEnabled()) return deliver(null);

  const queueOnFailure = PARSE_RETRY_ATTEMPTS > 0;
  const parsed = await parsePost(message.message, {
    channel: channelTitle,
    messageLink,
    attempt: 0,
    queueOnFailure,
  });
  if (parsed || !queueOnFailure) return deliver(parsed);

  try {
    await enqueuePost(
      {
        channelId: channelEntity.id.toString(),
        messageId: message.id,
        channelTitle,
        messageLink,
        keywords: matchedKeywords,
      },
      PARSE_RETRY_DELAY_MS
    );
    log("INFO", "Post queued for another AI parse attempt", {
      channel: channelTitle,
      messageId: message.id,
      retryInSec: PARSE_RETRY_DELAY_MS / 1000,
    });
  } catch (error) {
    log("WARN", "Could not queue post for retry, sending raw", {
      error: error instanceof Error ? error.message : String(error),
    });
    await deliver(null);
  }
}

function buildMessageLink(channelEntity: Api.Channel, messageId: number): string {
  return channelEntity.username
    ? `https://t.me/${channelEntity.username}/${messageId}`
    : `https://t.me/c/${channelEntity.id.toString()}/${messageId}`;
}

// Highest message id already handled per channel, shared by the event handler and the
// poller so each post is notified once
const lastProcessedIds = new Map<string, number>();

// Channels are only watched while someone is subscribed to the bot
let paused = false;

async function isWatching(): Promise<boolean> {
  let watching: boolean;
  try {
    watching = await hasActiveSubscribers();
  } catch (error) {
    log("WARN", "Could not check subscribers, keeping current watch state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return !paused;
  }
  if (watching === paused) {
    paused = !watching;
    log("INFO", watching
      ? "Subscriber present, resuming channel watching"
      : "No active subscribers, pausing channel watching");
  }
  if (!watching) {
    // Forget progress so posts published while paused are not replayed on resume
    lastProcessedIds.clear();
  }
  return watching;
}

async function processChannelMessage(
  client: TelegramClient,
  message: Api.Message,
  watched: { name: string; entity: Api.Channel },
  stats: MessageStats,
  source: "event" | "poll"
): Promise<void> {
  const { name: channelName, entity: channelEntity } = watched;
  const channelKey = channelEntity.id.toString();
  if (message.id <= (lastProcessedIds.get(channelKey) ?? 0)) return;
  lastProcessedIds.set(channelKey, message.id);

  if (!message.message) return;

  stats.messageCount++;
  const messageText = message.message;
  const channelTitle = channelEntity.title || channelName;
  recordPostStat(channelTitle, "checked");

  log("INFO", `New message received from ${channelTitle}`, {
    source,
    messageId: message.id,
    textPreview:
      messageText.substring(0, 100) +
      (messageText.length > 100 ? "..." : ""),
    textLength: messageText.length,
    date: message.date
      ? new Date(message.date * 1000).toISOString()
      : "unknown",
  });

  const matchedKeywords = findMatchingKeywords(messageText);

  if (matchedKeywords.length > 0) {
    stats.matchCount++;
    recordPostStat(channelTitle, "matched");
    const messageLink = buildMessageLink(channelEntity, message.id);

    log("INFO", `KEYWORD MATCH FOUND!`, {
      channel: channelTitle,
      matchedKeywords,
      messageId: message.id,
      link: messageLink,
      totalMatches: stats.matchCount,
    });

    await handleNotification(
      client,
      message,
      channelEntity,
      channelTitle,
      matchedKeywords,
      messageLink
    );
  } else {
    log("DEBUG", "No keywords matched in message", {
      channel: channelTitle,
      messageId: message.id,
    });
  }
}

export function setupMessageHandler(client: TelegramClient, stats: MessageStats): void {
  log("DEBUG", "Setting up NewMessage event handler");

  // No chats filter: the watched channel list can change at runtime (web UI),
  // so each message is checked against the current list instead
  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message) return;

      const chatId = message.chatId?.toString();
      const watched = chatId ? findWatchedChannel(chatId) : undefined;
      if (!watched) return;
      if (!(await isWatching())) return;

      await processChannelMessage(client, message, watched, stats, "event");
    },
    new NewMessage({})
  );

  log("INFO", "Event handler registered successfully");
}

// Telegram does not reliably push updates for busy channels, so every channel is also
// polled for posts newer than the last one handled
async function pollChannels(client: TelegramClient, stats: MessageStats): Promise<void> {
  if (!(await isWatching())) return;

  for (const watched of getResolvedChannels()) {
    const channelKey = watched.entity.id.toString();
    try {
      const lastId = lastProcessedIds.get(channelKey);
      if (lastId === undefined) {
        // First poll of this channel: start from its newest post, don't replay history
        const [latest] = await client.getMessages(watched.entity, { limit: 1 });
        lastProcessedIds.set(channelKey, latest?.id ?? 0);
        continue;
      }

      const messages = await client.getMessages(watched.entity, {
        minId: lastId,
        limit: POLL_BATCH_LIMIT,
      });
      // getMessages returns newest first
      for (const message of [...messages].reverse()) {
        await processChannelMessage(client, message, watched, stats, "poll");
      }
    } catch (error) {
      log("WARN", `Polling failed for channel: ${watched.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startChannelPolling(client: TelegramClient, stats: MessageStats): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollChannels(client, stats);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(tick, CHECK_INTERVAL_MS);
  log("INFO", `Polling channels every ${CHECK_INTERVAL_MS / 1000}s`);
}
