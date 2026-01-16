import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { log } from "../utils/logger.js";
import { findMatchingKeywords } from "../utils/keywords.js";
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

export function setupMessageHandler(
  client: TelegramClient,
  channelEntities: Map<string, Api.Channel>,
  stats: MessageStats
): void {
  const channelIds = Array.from(channelEntities.values()).map((ch) => ch.id);

  log("DEBUG", "Setting up NewMessage event handler", {
    channelIds: channelIds.map((id) => id.toString()),
  });

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message || !message.message) {
        log("DEBUG", "Received event without message text, skipping");
        return;
      }

      stats.messageCount++;
      const chat = await message.getChat();
      if (!chat || !("id" in chat)) {
        log("DEBUG", "Could not get chat from message, skipping");
        return;
      }

      const channelEntry = Array.from(channelEntities.entries()).find(
        ([_, entity]) => entity.id.equals(chat.id)
      );

      if (!channelEntry) {
        log("DEBUG", "Message from unwatched chat, skipping", {
          chatId: chat.id.toString(),
        });
        return;
      }

      const [channelName, channelEntity] = channelEntry;
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
        const messageLink = `https://t.me/${channelName}/${message.id}`;

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
    new NewMessage({ chats: channelIds })
  );

  log("INFO", "Event handler registered successfully");
}
