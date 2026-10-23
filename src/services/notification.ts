import { BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";
import { markBotBlocked } from "./users.js";

// Sends a post to one chat. Media is downloaded once by the caller and reused for every
// recipient. All requests share one throttle to stay under the Bot API limit (~30 messages
// a second across chats).

const MIN_REQUEST_INTERVAL_MS = 40;
// Uploads carry up to 10 photos, so they get longer than plain messages
const TEXT_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 120_000;
let nextRequestAt = 0;

// Telegram's limits on visible text, after HTML tags are parsed out
export const CAPTION_LIMIT = 1024;
export const MESSAGE_LIMIT = 4096;

// The same post laid out for a photo caption and for a text message; each already fits its limit
export interface PostCaption {
  media: string;
  text: string;
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

type SendResult = "ok" | "failed" | "blocked";

// Makes the request, waiting out one 429 (flood limit) before giving up
async function botRequest(
  chatId: string,
  method: string,
  body: () => BodyInit,
  json: boolean,
  timeoutMs: number
): Promise<SendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: json ? { "Content-Type": "application/json" } : undefined,
        body: body(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return "ok";

      const data = await response.json().catch(() => ({}));
      if (response.status === 429 && attempt === 0) {
        const retryAfterSec = data.parameters?.retry_after ?? 5;
        log("WARN", "Bot API flood limit, waiting", { chatId, method, retryAfterSec });
        await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
        continue;
      }
      log("ERROR", "Bot API returned error", { chatId, method, status: response.status, error: data });
      // 403: the user blocked the bot or deleted their account; stop sending to them
      if (response.status === 403) {
        await markBotBlocked(chatId);
        log("INFO", "User blocked the bot, marked unreachable", { chatId });
        return "blocked";
      }
      return "failed";
    } catch (error) {
      log("ERROR", "Failed to call Bot API", {
        chatId,
        method,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return "failed";
    }
  }
  return "failed";
}

function sendText(chatId: string, html: string): Promise<SendResult> {
  return botRequest(
    chatId,
    "sendMessage",
    () => JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
    true,
    TEXT_TIMEOUT_MS
  );
}

function sendPhoto(chatId: string, photo: Buffer, caption: string): Promise<SendResult> {
  return botRequest(chatId, "sendPhoto", () => {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");
    formData.append("photo", new Blob([new Uint8Array(photo)]), "photo.jpg");
    return formData;
  }, false, MEDIA_TIMEOUT_MS);
}

function sendAlbum(chatId: string, photos: Buffer[], caption: string): Promise<SendResult> {
  return botRequest(chatId, "sendMediaGroup", () => {
    const media = photos.map((_, index) => ({
      type: "photo" as const,
      media: `attach://photo${index}`,
      ...(index === 0 ? { caption, parse_mode: "HTML" as const } : {}),
    }));
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("media", JSON.stringify(media));
    photos.forEach((buffer, index) => {
      formData.append(`photo${index}`, new Blob([new Uint8Array(buffer)]), `photo${index}.jpg`);
    });
    return formData;
  }, false, MEDIA_TIMEOUT_MS);
}

// Photos with the caption, falling back to a text message if they can't be sent
export async function sendPostToChat(chatId: string, photos: Buffer[], caption: PostCaption): Promise<boolean> {
  const attempts = [
    ...(photos.length > 1 ? [() => sendAlbum(chatId, photos, caption.media)] : []),
    ...(photos.length === 1 ? [() => sendPhoto(chatId, photos[0], caption.media)] : []),
    () => sendText(chatId, caption.text),
  ];
  for (const attempt of attempts) {
    const result = await attempt();
    if (result === "ok") return true;
    if (result === "blocked") return false;
  }
  return false;
}
