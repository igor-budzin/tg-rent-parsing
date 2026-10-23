import http from "node:http";
import { APP_URL, BOT_TOKEN, PAYMENT_INSTRUCTIONS, SUPPORT_CONTACT } from "../../config.js";
import { log } from "../../utils/logger.js";
import {
  createSession,
  resolveSession,
  destroySession,
  verifyTelegramLogin,
  consumeLoginToken,
  isLoginThrottled,
  recordFailedLogin,
} from "../../services/auth.js";
import { getUser, upsertTelegramUser, touchLogin, setNotificationsEnabled, displayName, User } from "../../services/users.js";
import {
  ensureAccount,
  can,
  listMembers,
  listInvites,
  createInvite,
  revokeInvite,
  removeMember,
  setMemberRole,
  leaveAccount,
  renameAccount,
  Membership,
} from "../../services/accounts.js";
import { getFilters, addKeyword, removeKeyword, setRooms, setFloor, setPrice } from "../../services/account-filters.js";
import { getSubscriptionStatus, getAccountLimits } from "../../services/subscriptions.js";
import { listRecentMatches } from "../../services/posts.js";
import { deepLink, getBotUsername, sendBotText, escapeHtml } from "../../services/bot-api.js";
import {
  sendJson,
  sendHtml,
  redirect,
  readJson,
  requestUrl,
  getCookie,
  sessionCookie,
  clearCookie,
  clientIp,
  HttpError,
} from "../http.js";
import { userLoginPageHtml } from "./login-page.js";
import { USER_PAGES_HTML, USER_PAGE_PATHS } from "./dashboard-page.js";

const COOKIE = "session";
const INVITE_PREFIX = "inv_";

async function startSession(req: http.IncomingMessage, res: http.ServerResponse, user: User): Promise<void> {
  await ensureAccount(user);
  await touchLogin(user.id);
  const session = await createSession("user", user.id);
  log("INFO", "User logged in to the web app", { userId: user.id });
  redirect(res, "/", { "Set-Cookie": sessionCookie(req, COOKIE, session.token, session.maxAgeSec) });
}

async function loginPage(res: http.ServerResponse, error?: string, status = 200): Promise<void> {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(userLoginPageHtml(await getBotUsername(), BOT_TOKEN.split(":")[0], APP_URL, error));
}

async function meView(user: User, m: Membership) {
  const [subscription, limits, filters, members, invites] = await Promise.all([
    getSubscriptionStatus(m.accountId),
    getAccountLimits(m.accountId),
    getFilters(m.accountId),
    listMembers(m.accountId),
    can.invite(m.role) ? listInvites(m.accountId) : Promise.resolve([]),
  ]);
  return {
    user: {
      id: user.id,
      name: displayName(user),
      notificationsEnabled: user.notificationsEnabled,
      botBlocked: user.botBlocked,
      hasChat: Boolean(user.chatId),
    },
    account: { id: m.accountId, name: m.accountName, status: m.accountStatus, role: m.role },
    can: {
      editFilters: can.editFilters(m.role),
      invite: can.invite(m.role),
      manageMembers: can.manageMembers(m.role),
      rename: can.rename(m.role),
    },
    subscription,
    limits,
    filters,
    members: members.map(({ chatId, ...member }) => member),
    invites: await Promise.all(
      invites.map(async (i) => ({ id: i.id, role: i.role, expiresAt: i.expiresAt, link: await deepLink(INVITE_PREFIX + i.token) }))
    ),
    payment: { instructions: PAYMENT_INSTRUCTIONS, support: SUPPORT_CONTACT },
    botUsername: await getBotUsername(),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, route: string, user: User): Promise<void> {
  // Re-read on every request, so role changes and removals apply immediately
  const { membership: m } = await ensureAccount(user);
  const respond = async (error: string | null) => {
    if (error) throw new HttpError(400, error);
    const fresh = (await getUser(user.id)) ?? user;
    sendJson(res, 200, await meView(fresh, (await ensureAccount(fresh)).membership));
  };
  const requireEditor = () => {
    if (!can.editFilters(m.role)) throw new HttpError(403, "Змінювати фільтри можуть власник і редактори");
  };

  switch (route) {
    case "GET /api/me":
      return respond(null);

    case "GET /api/matches":
      sendJson(res, 200, await listRecentMatches(m.accountId));
      return;

    case "POST /api/keywords":
    case "DELETE /api/keywords": {
      requireEditor();
      const { value } = await readJson(req);
      if (typeof value !== "string") throw new HttpError(400, "Потрібно вказати значення");
      return respond(route.startsWith("POST") ? await addKeyword(m.accountId, value) : await removeKeyword(m.accountId, value));
    }

    case "PUT /api/rooms":
    case "PUT /api/floor":
    case "PUT /api/price": {
      requireEditor();
      const { value } = await readJson(req);
      const set = { "PUT /api/rooms": setRooms, "PUT /api/floor": setFloor, "PUT /api/price": setPrice }[route];
      return respond(await set(m.accountId, value));
    }

    case "PUT /api/notifications": {
      const { enabled } = await readJson(req);
      if (typeof enabled !== "boolean") throw new HttpError(400, "Некоректне значення");
      await setNotificationsEnabled(user.id, enabled);
      return respond(null);
    }

    case "PUT /api/account/name": {
      const { name } = await readJson(req);
      return respond(await renameAccount(m, String(name ?? "")));
    }

    case "POST /api/invites": {
      const { role } = await readJson(req);
      const invite = await createInvite(m, role);
      if (typeof invite === "string") throw new HttpError(400, invite);
      const link = await deepLink(INVITE_PREFIX + invite.token);
      if (!link) throw new HttpError(502, "Не вдалося отримати імʼя бота, спробуйте ще раз");
      sendJson(res, 200, { link, me: await meView(user, m) });
      return;
    }

    case "DELETE /api/invites": {
      const { id } = await readJson(req);
      return respond(await revokeInvite(m, String(id ?? "")));
    }

    case "DELETE /api/members": {
      const { userId } = await readJson(req);
      const result = await removeMember(m, String(userId ?? ""));
      if (typeof result === "string") throw new HttpError(400, result);
      if (result.chatId) {
        await sendBotText(result.chatId, `Вас видалено з акаунта «${escapeHtml(m.accountName)}». Сповіщення за його фільтрами більше не надходитимуть.`);
      }
      return respond(null);
    }

    case "PUT /api/members/role": {
      const { userId, role } = await readJson(req);
      return respond(await setMemberRole(m, String(userId ?? ""), role));
    }

    case "POST /api/leave":
      return respond(await leaveAccount(m));

    default:
      sendJson(res, 404, { error: "Not found" });
  }
}

export async function handleAppRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = requestUrl(req);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /login":
      return loginPage(res);

    // The login page forwards Telegram's signed user data here
    case "GET /auth/telegram": {
      const data = verifyTelegramLogin(url.searchParams);
      if (!data) return loginPage(res, "Не вдалося підтвердити вхід через Telegram. Спробуйте ще раз.", 400);
      // The widget asks for permission to write, so the bot can message the user in their private chat
      const user = await upsertTelegramUser({
        telegramUserId: data.id,
        chatId: data.id,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
      });
      if (user.status === "blocked") return loginPage(res, "Ваш доступ заблоковано. Зверніться до підтримки.", 403);
      return startSession(req, res, user);
    }

    // One-time link sent by the bot's /login and /start
    case "GET /auth/link": {
      const ip = clientIp(req);
      if (isLoginThrottled(`link:${ip}`)) return loginPage(res, "Забагато спроб. Спробуйте пізніше.", 429);
      const userId = await consumeLoginToken(url.searchParams.get("token") ?? "");
      const user = userId ? await getUser(userId) : null;
      if (!user) {
        recordFailedLogin(`link:${ip}`);
        return loginPage(res, "Посилання для входу недійсне або вже використане. Надішліть боту /login, щоб отримати нове.", 400);
      }
      if (user.status === "blocked") return loginPage(res, "Ваш доступ заблоковано. Зверніться до підтримки.", 403);
      return startSession(req, res, user);
    }

    case "GET /logout":
      await destroySession(getCookie(req, COOKIE));
      redirect(res, "/login", { "Set-Cookie": clearCookie(req, COOKIE) });
      return;
  }

  const userId = await resolveSession("user", getCookie(req, COOKIE));
  const user = userId ? await getUser(userId) : null;
  if (!user || user.status === "blocked") {
    if (req.method === "GET" && USER_PAGE_PATHS[url.pathname]) redirect(res, "/login");
    else sendJson(res, 401, { error: "Потрібно увійти" });
    return;
  }

  const page = req.method === "GET" ? USER_PAGE_PATHS[url.pathname] : undefined;
  if (page) {
    sendHtml(res, USER_PAGES_HTML[page]);
    return;
  }
  await handleApi(req, res, route, user);
}
