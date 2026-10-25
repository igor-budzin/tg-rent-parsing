import http from "node:http";
import { APP_URL, BOT_TOKEN, PAYMENT_INSTRUCTIONS, SUPPORT_CONTACT } from "../../config.js";
import { log } from "../../utils/logger.js";
import {
  createSession,
  resolveSession,
  destroySession,
  verifyTelegramLogin,
  consumeLoginToken,
  peekLoginToken,
  takeLoginAttempt,
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
  sessionCookieName,
  clearCookie,
  clientIp,
  requireId,
  HttpError,
} from "../http.js";
import { RateLimiter } from "../../utils/rate-limit.js";
import { userLoginPageHtml, linkConfirmPageHtml } from "./login-page.js";
import { USER_PAGES_HTML, USER_PAGE_PATHS } from "./dashboard-page.js";

const COOKIE = "session";
const INVITE_PREFIX = "inv_";

// The Set-Cookie header for a new session
async function startSession(req: http.IncomingMessage, user: User): Promise<string> {
  await ensureAccount(user);
  await touchLogin(user.id);
  const session = await createSession("user", user.id);
  log("INFO", "User logged in to the web app", { userId: user.id });
  return sessionCookie(req, sessionCookieName(req, COOKIE), session.token, session.maxAgeSec);
}

async function loginPage(res: http.ServerResponse, error?: string, status = 200): Promise<void> {
  sendHtml(res, userLoginPageHtml(await getBotUsername(), BOT_TOKEN.split(":")[0], APP_URL, error), {}, status);
}

async function meView(user: User, m: Membership) {
  const [subscription, filters, members, invites, botUsername] = await Promise.all([
    getSubscriptionStatus(m.accountId),
    getFilters(m.accountId),
    listMembers(m.accountId),
    can.invite(m.role) ? listInvites(m.accountId) : Promise.resolve([]),
    getBotUsername(),
  ]);
  const limits = await getAccountLimits(m.accountId, undefined, subscription);
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
    // Links can't be rebuilt from the stored hash; the page shows each one once, on creation
    invites: invites.map((i) => ({ id: i.id, role: i.role, expiresAt: i.expiresAt })),
    payment: { instructions: PAYMENT_INSTRUCTIONS, support: SUPPORT_CONTACT },
    botUsername,
  };
}

// Changes per user per minute: generous for clicking around (the keyword form sends one request per
// keyword), but stops scripts hammering the database or creating rows in a loop
const mutationLimiter = new RateLimiter(60, 60_000);

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, route: string, user: User): Promise<void> {
  if (req.method !== "GET" && !mutationLimiter.take(user.id)) {
    throw new HttpError(429, "Забагато змін за хвилину. Спробуйте трохи пізніше.");
  }
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
      return respond(await revokeInvite(m, requireId(id, "ID запрошення")));
    }

    case "DELETE /api/members": {
      const { userId } = await readJson(req);
      const result = await removeMember(m, requireId(userId, "ID користувача"));
      if (typeof result === "string") throw new HttpError(400, result);
      if (result.chatId) {
        await sendBotText(result.chatId, `Вас видалено з акаунта «${escapeHtml(m.accountName)}». Сповіщення за його фільтрами більше не надходитимуть.`);
      }
      return respond(null);
    }

    case "PUT /api/members/role": {
      const { userId, role } = await readJson(req);
      return respond(await setMemberRole(m, requireId(userId, "ID користувача"), role));
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

    // Earlier versions of the login page navigated here; the data now comes by POST
    case "GET /auth/telegram":
      redirect(res, "/login");
      return;

    // The login page POSTs Telegram's signed user data here as JSON
    case "POST /auth/telegram": {
      const { data: raw } = await readJson(req);
      const params = new URLSearchParams();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
        }
      }
      const data = verifyTelegramLogin(params);
      if (!data) throw new HttpError(400, "Не вдалося підтвердити вхід через Telegram. Спробуйте ще раз.");
      // The widget asks for permission to write, so the bot can message the user in their private chat
      const user = await upsertTelegramUser({
        telegramUserId: data.id,
        chatId: data.id,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
      });
      if (user.status === "blocked") throw new HttpError(403, "Ваш доступ заблоковано. Зверніться до підтримки.");
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": await startSession(req, user) });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // One-time link sent by the bot's /login and /start. Opening it only shows whose account it
    // signs in to; a button (POST) signs in. So a link someone else sends can't quietly sign the
    // victim in to the sender's account (login CSRF), and link previews don't use it up.
    case "GET /auth/link":
    case "POST /auth/link": {
      const ip = clientIp(req);
      // Counted as failed until the token checks out, see takeLoginAttempt
      const release = await takeLoginAttempt(`link:${ip}`);
      if (!release) return loginPage(res, "Забагато спроб. Спробуйте пізніше.", 429);
      const token = url.searchParams.get("token") ?? "";
      const confirming = req.method === "POST";
      const userId = confirming ? await consumeLoginToken(token) : await peekLoginToken(token);
      const user = userId ? await getUser(userId) : null;
      if (!user) {
        return loginPage(res, "Посилання для входу недійсне або вже використане. Надішліть боту /login, щоб отримати нове.", 400);
      }
      await release();
      if (user.status === "blocked") return loginPage(res, "Ваш доступ заблоковано. Зверніться до підтримки.", 403);
      if (!confirming) {
        sendHtml(res, linkConfirmPageHtml(displayName(user), user.username, token));
        return;
      }
      redirect(res, "/", { "Set-Cookie": await startSession(req, user) });
      return;
    }

    // POST only (a form button), so another site can't log users out with a link or an image;
    // the cross-site check in server.ts rejects a POST from another origin
    case "POST /logout": {
      const cookie = sessionCookieName(req, COOKIE);
      await destroySession(getCookie(req, cookie));
      redirect(res, "/login", { "Set-Cookie": clearCookie(req, cookie) });
      return;
    }

    // Old bookmarks and links: back to the app, signed in as before
    case "GET /logout":
      redirect(res, "/");
      return;
  }

  const userId = await resolveSession("user", getCookie(req, sessionCookieName(req, COOKIE)));
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
