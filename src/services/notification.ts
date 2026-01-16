import { TelegramClient, Api } from "telegram";
import { BOT_TOKEN, TELEGRAM_USER_ID } from "../config.js";
import { log } from "../utils/logger.js";
import { NotifyEntity } from "../types/index.js";

export function isUsingBot(): boolean {
  return !!(BOT_TOKEN && TELEGRAM_USER_ID);
}

function convertMarkdownToHtml(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, "<b>$1</b>")
    .replace(/_([^_]+)_/g, "<i>$1</i>");
}

async function sendViaBotApi(message: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const htmlMessage = convertMarkdownToHtml(message);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: htmlMessage,
        parse_mode: "HTML",
      }),
    });

    const responseData = await response.json();

    if (!response.ok) {
      log("ERROR", "Bot API returned error", {
        status: response.status,
        error: responseData,
        hint: responseData?.description?.includes("chat not found")
          ? "You need to start a chat with your bot first! Send /start to your bot."
          : undefined,
      });
      return false;
    }

    log("INFO", "Notification sent via bot successfully");
    return true;
  } catch (error) {
    log("ERROR", "Failed to send bot notification", { error });
    return false;
  }
}

async function sendViaClient(
  client: TelegramClient,
  notifyEntity: NotifyEntity,
  message: string
): Promise<boolean> {
  try {
    await client.sendMessage(notifyEntity, {
      message,
      parseMode: "md",
    });
    log("INFO", "Notification sent successfully");
    return true;
  } catch (error) {
    log("ERROR", "Failed to send notification", { error });
    return false;
  }
}

export async function sendNotification(
  client: TelegramClient,
  notifyEntity: NotifyEntity,
  message: string,
  useBot: boolean
): Promise<boolean> {
  log("DEBUG", "Sending notification message...");

  if (useBot) {
    return sendViaBotApi(message);
  }
  return sendViaClient(client, notifyEntity, message);
}

export async function sendPhotoNotification(
  photoBuffer: Buffer,
  caption: string
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("chat_id", TELEGRAM_USER_ID);
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
      log("ERROR", "Failed to send photo via bot", { error: responseData });
      return false;
    }

    log("INFO", "Photo notification sent via bot successfully");
    return true;
  } catch (error) {
    log("ERROR", "Failed to send photo notification", { error });
    return false;
  }
}

export async function sendAlbumNotification(
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
    formData.append("chat_id", TELEGRAM_USER_ID);
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
      log("ERROR", "Failed to send album via bot", { error: responseData });
      return false;
    }

    log("INFO", "Album notification sent via bot successfully", {
      photoCount: photoBuffers.length,
    });
    return true;
  } catch (error) {
    log("ERROR", "Failed to send album notification", { error });
    return false;
  }
}
