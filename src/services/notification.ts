import { BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";
import { getActiveSubscriberIds, removeSubscriber } from "./subscribers.js";

function convertMarkdownToHtml(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, "<b>$1</b>")
    .replace(/_([^_]+)_/g, "<i>$1</i>");
}

// 403 means the user blocked the bot or deleted their account — stop sending to them
async function handleSendFailure(userId: string, status: number): Promise<void> {
  if (status === 403) {
    await removeSubscriber(userId);
    log("INFO", "Unsubscribed user who blocked the bot", { userId });
  }
}

async function sendToAllSubscribers(
  label: string,
  send: (userId: string) => Promise<boolean>,
  extra?: Record<string, unknown>
): Promise<boolean> {
  const userIds = await getActiveSubscriberIds();
  if (userIds.length === 0) {
    log("WARN", `${label} skipped: no subscribers`);
    return false;
  }

  const results = await Promise.all(userIds.map(send));
  const successCount = results.filter(Boolean).length;
  log("INFO", `${label} sent`, { success: successCount, total: userIds.length, ...extra });

  return successCount > 0;
}

async function sendMessageToUser(userId: string, htmlMessage: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: htmlMessage,
        parse_mode: "HTML",
      }),
    });

    const responseData = await response.json();

    if (!response.ok) {
      log("ERROR", "Bot API returned error", {
        userId,
        status: response.status,
        error: responseData,
      });
      await handleSendFailure(userId, response.status);
      return false;
    }

    return true;
  } catch (error) {
    log("ERROR", "Failed to send bot notification", { userId, error });
    return false;
  }
}

export async function sendNotification(message: string): Promise<boolean> {
  log("DEBUG", "Sending notification message...");

  const htmlMessage = convertMarkdownToHtml(message);
  return sendToAllSubscribers("Notifications", (userId) =>
    sendMessageToUser(userId, htmlMessage)
  );
}

async function sendPhotoToUser(
  userId: string,
  photoBuffer: Buffer,
  caption: string
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", userId);
    formData.append("caption", caption.substring(0, 1024));
    formData.append("parse_mode", "HTML");
    formData.append("photo", new Blob([new Uint8Array(photoBuffer)]), "photo.jpg");

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        body: formData,
      }
    );

    if (!response.ok) {
      const responseData = await response.json();
      log("ERROR", "Failed to send photo via bot", { userId, error: responseData });
      await handleSendFailure(userId, response.status);
      return false;
    }

    return true;
  } catch (error) {
    log("ERROR", "Failed to send photo notification", { userId, error });
    return false;
  }
}

export async function sendPhotoNotification(
  photoBuffer: Buffer,
  caption: string
): Promise<boolean> {
  return sendToAllSubscribers("Photo notifications", (userId) =>
    sendPhotoToUser(userId, photoBuffer, caption)
  );
}

async function sendAlbumToUser(
  userId: string,
  photoBuffers: Buffer[],
  caption: string
): Promise<boolean> {
  try {
    const media = photoBuffers.map((_, index) => ({
      type: "photo" as const,
      media: `attach://photo${index}`,
      ...(index === 0
        ? { caption: caption.substring(0, 1024), parse_mode: "HTML" as const }
        : {}),
    }));

    const formData = new FormData();
    formData.append("chat_id", userId);
    formData.append("media", JSON.stringify(media));
    photoBuffers.forEach((buffer, index) => {
      formData.append(
        `photo${index}`,
        new Blob([new Uint8Array(buffer)]),
        `photo${index}.jpg`
      );
    });

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`,
      {
        method: "POST",
        body: formData,
      }
    );

    if (!response.ok) {
      const responseData = await response.json();
      log("ERROR", "Failed to send album via bot", { userId, error: responseData });
      await handleSendFailure(userId, response.status);
      return false;
    }

    return true;
  } catch (error) {
    log("ERROR", "Failed to send album notification", { userId, error });
    return false;
  }
}

export async function sendAlbumNotification(
  photoBuffers: Buffer[],
  caption: string
): Promise<boolean> {
  return sendToAllSubscribers(
    "Album notifications",
    (userId) => sendAlbumToUser(userId, photoBuffers, caption),
    { photoCount: photoBuffers.length }
  );
}
