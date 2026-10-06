import { BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";
import { addSubscriber, removeSubscriber } from "./subscribers.js";

const POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_MS = 5000;

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: TelegramUser;
    text?: string;
  };
  my_chat_member?: {
    chat: { id: number; type: string };
    new_chat_member: { status: string };
  };
}

async function callBotApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.error_code} ${data.description}`);
  }
  return data.result as T;
}

async function reply(chatId: number, text: string): Promise<void> {
  try {
    await callBotApi("sendMessage", { chat_id: chatId, text });
  } catch (error) {
    log("ERROR", "Failed to reply to bot command", { chatId, error: String(error) });
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.my_chat_member) {
    const { chat, new_chat_member } = update.my_chat_member;
    if (chat.type === "private" && new_chat_member.status === "kicked") {
      await removeSubscriber(String(chat.id));
      log("INFO", "User blocked the bot, unsubscribed", { chatId: chat.id });
    }
    return;
  }

  const message = update.message;
  if (!message?.text || message.chat.type !== "private") return;

  const command = message.text.trim().split(/[\s@]/)[0].toLowerCase();
  const chatId = message.chat.id;

  if (command === "/start") {
    await addSubscriber({
      chatId: String(chatId),
      username: message.from?.username,
      firstName: message.from?.first_name,
      lastName: message.from?.last_name,
    });
    log("INFO", "User subscribed", { chatId, username: message.from?.username });
    await reply(chatId, "You are subscribed to rent notifications. Send /stop to unsubscribe.");
  } else if (command === "/stop") {
    await removeSubscriber(String(chatId));
    log("INFO", "User unsubscribed", { chatId, username: message.from?.username });
    await reply(chatId, "You are unsubscribed. Send /start to subscribe again.");
  }
}

export async function startBotUpdatesPolling(): Promise<void> {
  let offset = 0;

  while (true) {
    try {
      const updates = await callBotApi<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ["message", "my_chat_member"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          log("ERROR", "Failed to handle bot update", {
            updateId: update.update_id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      // 409 happens when another instance is polling (e.g. during a redeploy) or a webhook is set
      log("WARN", "Bot getUpdates failed, retrying", { error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
