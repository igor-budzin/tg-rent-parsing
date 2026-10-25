import { APP_URL, PAYMENT_INSTRUCTIONS, SUPPORT_CONTACT } from "../config.js";
import { log } from "../utils/logger.js";
import { BOT_API_TIMEOUT_MS, callBotApi, escapeHtml, sendBotText } from "./bot-api.js";
import { upsertTelegramUser, markBotBlocked, setNotificationsEnabled, User, displayName } from "./users.js";
import { ensureAccount, previewInvite, acceptInvite, listMembers, getMembership, Role } from "./accounts.js";
import { getSubscriptionStatus } from "./subscriptions.js";
import { createLoginToken } from "./auth.js";
import { RateLimiter } from "../utils/rate-limit.js";

const POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_MS = 5000;
const INVITE_PREFIX = "inv_";

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
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
  my_chat_member?: {
    chat: { id: number; type: string };
    new_chat_member: { status: string };
  };
}

// Reply-keyboard buttons; pressing one sends its label as a plain text message.
// They turn this person's notifications on and off; the account stays as it is.
const START_BUTTON = "▶️ Підписатися";
const STOP_BUTTON = "⏹ Зупинити";

const ROLE_NAMES: Record<Role, string> = { owner: "власник", editor: "редактор", viewer: "глядач" };

// The web app opened inside Telegram as a Mini App; the login page signs in with the initData
// Telegram passes. Telegram only accepts HTTPS URLs, so there are no Mini App buttons in local
// development.
const WEB_APP_BUTTON = "Відкрити кабінет";
const WEB_APP_URL = APP_URL.startsWith("https://") ? `${APP_URL}/login` : null;

function keyboardWith(button: string) {
  return { keyboard: [[{ text: button }]], resize_keyboard: true, is_persistent: true };
}

async function reply(chatId: number, html: string, button?: string): Promise<void> {
  await sendBotText(chatId, html, {
    disable_web_page_preview: true,
    ...(button ? { reply_markup: keyboardWith(button) } : {}),
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", year: "numeric" });
}

async function loginLink(user: User): Promise<string> {
  const token = await createLoginToken(user.id);
  return `${APP_URL}/auth/link?token=${token}`;
}

export function paymentHint(): string {
  const lines = [];
  if (PAYMENT_INSTRUCTIONS) lines.push(escapeHtml(PAYMENT_INSTRUCTIONS));
  if (SUPPORT_CONTACT) lines.push(`Звʼязок: ${escapeHtml(SUPPORT_CONTACT)}`);
  return lines.join("\n");
}

async function statusText(user: User): Promise<string> {
  const membership = await getMembership(user.id);
  if (!membership) return "У вас ще немає акаунта. Надішліть /start.";
  const status = await getSubscriptionStatus(membership.accountId);
  const lines = [
    `<b>Акаунт:</b> ${escapeHtml(membership.accountName)} (${ROLE_NAMES[membership.role]})`,
    status.active
      ? `<b>Підписка:</b> ${status.kind === "trial" ? "пробний період" : escapeHtml(status.plan?.name ?? "активна")} до ${formatDate(status.endsAt!)}`
      : "<b>Підписка:</b> неактивна — сповіщення не надсилаються",
    `<b>Сповіщення:</b> ${user.notificationsEnabled ? "увімкнені" : "вимкнені"}`,
  ];
  if (!status.active && paymentHint()) lines.push("", paymentHint());
  return lines.join("\n");
}

function profileOf(from: TelegramUser, chatId: number) {
  return {
    telegramUserId: String(from.id),
    chatId: String(chatId),
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
  };
}

const BLOCKED_TEXT = "Ваш доступ заблоковано. Зверніться до підтримки.";

// Users blocked by an admin can't start, join accounts or get login links from the bot either
async function refuseIfBlocked(user: User, chatId: number): Promise<boolean> {
  if (user.status !== "blocked") return false;
  await reply(chatId, escapeHtml(BLOCKED_TEXT) + (SUPPORT_CONTACT ? `\nЗвʼязок: ${escapeHtml(SUPPORT_CONTACT)}` : ""));
  return true;
}

async function handleStart(chatId: number, from: TelegramUser, payload: string): Promise<void> {
  const user = await upsertTelegramUser(profileOf(from, chatId));
  if (await refuseIfBlocked(user, chatId)) return;

  if (payload.startsWith(INVITE_PREFIX)) {
    const token = payload.slice(INVITE_PREFIX.length);
    const preview = await previewInvite(token, user);
    if (typeof preview === "string") {
      await reply(chatId, escapeHtml(preview));
      return;
    }
    const leaving = preview.leavingAccountName
      ? `\n\nВи покинете поточний акаунт «${escapeHtml(preview.leavingAccountName)}».`
      : "";
    await sendBotText(
      chatId,
      `Вас запрошено до акаунта «<b>${escapeHtml(preview.accountName)}</b>» як ${ROLE_NAMES[preview.role]}. ` +
        `Ви отримуватимете сповіщення за його фільтрами.${leaving}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Приєднатися", callback_data: `join:${token}` },
            { text: "Скасувати", callback_data: "cancel" },
          ]],
        },
      }
    );
    return;
  }

  const { membership, created, trialStarted } = await ensureAccount(user);
  await setNotificationsEnabled(user.id, true);
  log("INFO", "User started the bot", { chatId, username: from.username, accountId: membership.accountId, created });

  const intro = trialStarted
    ? "Вітаємо! Для вас увімкнено пробний період — сповіщення про нові оголошення вже надходитимуть.\n\n"
    : "";
  await reply(
    chatId,
    `${intro}${await statusText({ ...user, notificationsEnabled: true })}\n\n` +
      `Налаштуйте ключові слова, кімнати, поверх і ціну у веб-кабінеті: ${await loginLink(user)}\n` +
      `Посилання одноразове й діє 15 хвилин; нове — командою /login.`,
    STOP_BUTTON
  );
}

async function handleJoin(callbackId: string, chatId: number, messageId: number, from: TelegramUser, token: string): Promise<void> {
  const user = await upsertTelegramUser(profileOf(from, chatId));
  const result = user.status === "blocked" ? BLOCKED_TEXT : await acceptInvite(token, user);
  await callBotApi("answerCallbackQuery", { callback_query_id: callbackId }).catch(() => {});

  const text = typeof result === "string"
    ? escapeHtml(result)
    : `Ви приєдналися до акаунта «<b>${escapeHtml(result.accountName)}</b>». Сповіщення надходитимуть сюди.\n\nВеб-кабінет: /login`;
  await callBotApi("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }).catch(
    (error) => log("WARN", "Could not edit invite message", { error: String(error) })
  );
  if (typeof result === "string") return;

  await setNotificationsEnabled(user.id, true);
  log("INFO", "User joined an account by invite", { userId: user.id, accountId: result.accountId });
  for (const member of await listMembers(result.accountId)) {
    if (member.userId === user.id || !member.chatId || member.botBlocked) continue;
    await sendBotText(member.chatId, `${escapeHtml(displayName(user))} приєднався(-лася) до акаунта «${escapeHtml(result.accountName)}».`);
  }
}

async function handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const message = query.message;
  if (!message || message.chat.type !== "private" || !query.data) return;
  if (query.data.startsWith("join:")) {
    await handleJoin(query.id, message.chat.id, message.message_id, query.from, query.data.slice(5));
  } else if (query.data === "cancel") {
    await callBotApi("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
    await callBotApi("editMessageText", { chat_id: message.chat.id, message_id: message.message_id, text: "Запрошення відхилено." }).catch(() => {});
  }
}

// Commands and button presses per Telegram user per minute: plenty for a person, but a script
// can't fill the database with login links and users
const updateLimiter = new RateLimiter(20, 60_000);

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
  if (fromId !== undefined && !updateLimiter.take(String(fromId))) {
    log("DEBUG", "Bot update ignored: too many from this user", { fromId });
    return;
  }
  if (update.my_chat_member) {
    const { chat, new_chat_member } = update.my_chat_member;
    if (chat.type === "private" && new_chat_member.status === "kicked") {
      await markBotBlocked(String(chat.id));
      log("INFO", "User blocked the bot", { chatId: chat.id });
    }
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.text || !message.from || message.chat.type !== "private") return;

  const text = message.text.trim();
  const [rawCommand, payload = ""] = text.split(/\s+/, 2);
  const command = rawCommand.split("@")[0].toLowerCase();
  const chatId = message.chat.id;

  if (command === "/start" || text === START_BUTTON) {
    await handleStart(chatId, message.from, command === "/start" ? payload : "");
  } else if (command === "/stop" || text === STOP_BUTTON) {
    const user = await upsertTelegramUser(profileOf(message.from, chatId));
    await setNotificationsEnabled(user.id, false);
    log("INFO", "User turned notifications off", { chatId, username: message.from.username });
    await reply(
      chatId,
      `Сповіщення вимкнено. Натисніть «${START_BUTTON}», щоб увімкнути знову. Акаунт і фільтри збережено.`,
      START_BUTTON
    );
  } else if (command === "/login") {
    const user = await upsertTelegramUser(profileOf(message.from, chatId));
    if (await refuseIfBlocked(user, chatId)) return;
    await ensureAccount(user);
    await sendBotText(chatId, `Вхід у веб-кабінет (одноразове посилання, діє 15 хвилин):\n${await loginLink(user)}`, {
      disable_web_page_preview: true,
      ...(WEB_APP_URL ? { reply_markup: { inline_keyboard: [[{ text: WEB_APP_BUTTON, web_app: { url: WEB_APP_URL } }]] } } : {}),
    });
  } else if (command === "/status") {
    const user = await upsertTelegramUser(profileOf(message.from, chatId));
    if (await refuseIfBlocked(user, chatId)) return;
    await ensureAccount(user);
    await reply(chatId, await statusText(user));
  }
}

// The menu button next to the message field in every private chat with the bot
async function setWebAppMenuButton(): Promise<void> {
  if (!WEB_APP_URL) return;
  await callBotApi("setChatMenuButton", {
    menu_button: { type: "web_app", text: WEB_APP_BUTTON, web_app: { url: WEB_APP_URL } },
  }).catch((error) => log("WARN", "Could not set the bot menu button", { error: String(error) }));
}

export async function startBotUpdatesPolling(): Promise<void> {
  let offset = 0;
  await setWebAppMenuButton();

  while (true) {
    try {
      // Long poll: Telegram holds the request up to POLL_TIMEOUT_SEC, so allow for that
      const updates = await callBotApi<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message", "callback_query", "my_chat_member"] },
        POLL_TIMEOUT_SEC * 1000 + BOT_API_TIMEOUT_MS
      );

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
