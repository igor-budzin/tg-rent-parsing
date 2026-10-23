import { BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";

// Thin Bot API client shared by the update poller, notifications and background jobs

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number
  ) {
    super(`${method} failed: ${status} ${description}`);
  }
}

// Without a timeout a stalled connection would block its caller forever: the update poller,
// or a delivery holding up the whole channel loop
export const BOT_API_TIMEOUT_MS = 30_000;

export async function callBotApi<T>(
  method: string,
  body: Record<string, unknown>,
  timeoutMs = BOT_API_TIMEOUT_MS
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new BotApiError(method, data.error_code, data.description, data.parameters?.retry_after);
  }
  return data.result as T;
}

let botUsername: string | null = null;

// Needed for t.me deep links and the login widget
export async function getBotUsername(): Promise<string | null> {
  if (botUsername) return botUsername;
  try {
    const me = await callBotApi<{ username: string }>("getMe", {});
    botUsername = me.username;
  } catch (error) {
    log("WARN", "Could not get bot username", { error: String(error) });
  }
  return botUsername;
}

export async function deepLink(payload: string): Promise<string | null> {
  const username = await getBotUsername();
  return username ? `https://t.me/${username}?start=${payload}` : null;
}

// Plain service message (reminders, membership changes); failures are only logged
export async function sendBotText(chatId: string | number, html: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await callBotApi("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...extra });
    return true;
  } catch (error) {
    log("WARN", "Could not send bot message", { chatId, error: String(error) });
    return false;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
