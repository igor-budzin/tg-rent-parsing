import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { log } from "../utils/logger.js";
import { findMatchingKeywords } from "../utils/keywords.js";
import { findWatchedChannel, getResolvedChannels } from "../services/watch-config.js";
import { CHECK_INTERVAL_MS } from "../config.js";
import {
  sendNotification,
  sendPhotoNotification,
  sendAlbumNotification,
} from "../services/notification.js";
import { parsePost } from "../services/post-parser.js";
import { MessageStats, ParsedPost } from "../types/index.js";

// Max posts fetched per channel per poll
const POLL_BATCH_LIMIT = 100;

async function downloadAlbumPhotos(
  client: TelegramClient,
  channelEntity: Api.Channel,
  groupedId: Api.long
): Promise<Buffer[]> {
  const messages = await client.getMessages(channelEntity, {
    ids: undefined,
    limit: 10,
  });

  const albumMessages = messages.filter((m) => m.groupedId?.equals(groupedId));
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

async function handleNotification(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  channelTitle: string,
  matchedKeywords: string[],
  messageLink: string
): Promise<void> {
  const parsed = await parsePost(message.message);
  const caption = parsed
    ? formatParsedCaption(parsed, channelTitle, messageLink)
    : `<b>Match found!</b>\n\n<b>Channel:</b> ${channelTitle}\n<b>Keywords:</b> ${matchedKeywords.join(", ")}\n\n${message.message}\n\n${messageLink}`;

  const groupedId = message.groupedId;

  if (groupedId) {
    try {
      const photoBuffers = await downloadAlbumPhotos(
        client,
        channelEntity,
        groupedId
      );

      if (photoBuffers.length > 1) {
        const success = await sendAlbumNotification(photoBuffers, caption);
        if (!success) {
          await sendNotification(caption);
        }
      } else if (photoBuffers.length === 1) {
        const success = await sendPhotoNotification(photoBuffers[0], caption);
        if (!success) {
          await sendNotification(caption);
        }
      } else {
        await sendNotification(caption);
      }
    } catch (error) {
      log("ERROR", "Failed to process album", { error });
      await sendNotification(caption);
    }
  } else if (message.photo) {
    try {
      const photoBuffer = (await client.downloadMedia(message, {})) as Buffer;
      if (photoBuffer) {
        const success = await sendPhotoNotification(photoBuffer, caption);
        if (!success) {
          await sendNotification(caption);
        }
      } else {
        await sendNotification(caption);
      }
    } catch (error) {
      log("ERROR", "Failed to download/send photo", { error });
      await sendNotification(caption);
    }
  } else {
    await sendNotification(caption);
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

      await processChannelMessage(client, message, watched, stats, "event");
    },
    new NewMessage({})
  );

  log("INFO", "Event handler registered successfully");
}

// Telegram does not reliably push updates for busy channels, so every channel is also
// polled for posts newer than the last one handled
async function pollChannels(client: TelegramClient, stats: MessageStats): Promise<void> {
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
