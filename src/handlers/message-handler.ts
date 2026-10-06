import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { log } from "../utils/logger.js";
import { findMatchingKeywords } from "../utils/keywords.js";
import { findWatchedChannel } from "../services/watch-config.js";
import {
  sendNotification,
  sendPhotoNotification,
  sendAlbumNotification,
} from "../services/notification.js";
import { MessageStats } from "../types/index.js";

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

async function handleNotification(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  channelTitle: string,
  matchedKeywords: string[],
  messageLink: string
): Promise<void> {
  const caption = `<b>Match found!</b>\n\n<b>Channel:</b> ${channelTitle}\n<b>Keywords:</b> ${matchedKeywords.join(", ")}\n\n${message.message}\n\n${messageLink}`;

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

export function setupMessageHandler(client: TelegramClient, stats: MessageStats): void {
  log("DEBUG", "Setting up NewMessage event handler");

  // No chats filter: the watched channel list can change at runtime (web UI),
  // so each message is checked against the current list instead
  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message || !message.message) {
        log("DEBUG", "Received event without message text, skipping");
        return;
      }

      const chatId = message.chatId?.toString();
      const watched = chatId ? findWatchedChannel(chatId) : undefined;
      if (!watched) return;

      stats.messageCount++;
      const { name: channelName, entity: channelEntity } = watched;
      const messageText = message.message;
      const channelTitle = channelEntity.title || channelName;

      log("INFO", `New message received from ${channelTitle}`, {
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
    },
    new NewMessage({})
  );

  log("INFO", "Event handler registered successfully");
}
