import { BOT_TOKEN, TELEGRAM_USER_IDS } from "../config.js";
import { log } from "../utils/logger.js";

export function isUsingBot(): boolean {
  return !!(BOT_TOKEN && TELEGRAM_USER_IDS.length > 0);
}

function convertMarkdownToHtml(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, "<b>$1</b>")
    .replace(/_([^_]+)_/g, "<i>$1</i>");
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
        hint: responseData?.description?.includes("chat not found")
          ? "User needs to start a chat with your bot first! Send /start to your bot."
          : undefined,
      });
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
  const results = await Promise.all(
    TELEGRAM_USER_IDS.map((userId) => sendMessageToUser(userId, htmlMessage))
  );

  const successCount = results.filter(Boolean).length;
  log("INFO", "Notifications sent", {
    success: successCount,
    total: TELEGRAM_USER_IDS.length,
  });

  return successCount > 0;
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
  const results = await Promise.all(
    TELEGRAM_USER_IDS.map((userId) => sendPhotoToUser(userId, photoBuffer, caption))
  );

  const successCount = results.filter(Boolean).length;
  log("INFO", "Photo notifications sent", {
    success: successCount,
    total: TELEGRAM_USER_IDS.length,
  });

  return successCount > 0;
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
  const results = await Promise.all(
    TELEGRAM_USER_IDS.map((userId) => sendAlbumToUser(userId, photoBuffers, caption))
  );

  const successCount = results.filter(Boolean).length;
  log("INFO", "Album notifications sent", {
    success: successCount,
    total: TELEGRAM_USER_IDS.length,
    photoCount: photoBuffers.length,
  });

  return successCount > 0;
}
