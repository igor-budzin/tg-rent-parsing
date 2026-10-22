import http from "node:http";
import { log } from "../../utils/logger.js";
import {
  getAuthState,
  startLogin,
  submitInput,
  cancelLogin,
  getAccount,
} from "../../services/telegram-auth.js";
import { listParseFailures, clearParseFailures } from "../../services/parse-failures.js";
import { getPostStats, clearPostStats } from "../../services/post-stats.js";
import {
  getWatchConfigView,
  addChannel,
  removeChannel,
  getChannelPhoto,
} from "../../services/watch-config.js";
import { countRecipients } from "../../services/audience.js";
import {
  listAccounts,
  getAccountDetail,
  setAccountStatus,
  transferOwnership,
  moveUserToAccount,
  adminRemoveMember,
} from "../../services/accounts.js";
import { getFilters } from "../../services/account-filters.js";
import {
  listPlans,
  getPlan,
  savePlan,
  grantSubscription,
  cancelSubscription,
  listSubscriptions,
  listPayments,
  getBusinessOverview,
} from "../../services/subscriptions.js";
import { searchUsers, setUserStatus } from "../../services/users.js";
import { listAudit, audit, Actor } from "../../services/audit.js";
import {
  createSession,
  resolveSession,
  destroySession,
  checkAdminPassword,
  isLoginThrottled,
  recordFailedLogin,
  listAdmins,
  createAdmin,
  changeAdminPassword,
} from "../../services/auth.js";
import {
  sendJson,
  sendHtml,
  sendResult,
  redirect,
  readJson,
  requestUrl,
  getCookie,
  sessionCookie,
  clearCookie,
  clientIp,
  HttpError,
} from "../http.js";
import { LOGIN_PAGE_HTML } from "./login-page.js";
import { SETTINGS_PAGE_HTML } from "./settings-page.js";
import { FAILURES_PAGE_HTML } from "./failures-page.js";
import { STATS_PAGE_HTML } from "./stats-page.js";
import { ADMIN_LOGIN_PAGE_HTML } from "./admin-login-page.js";
import { ACCOUNTS_PAGE_HTML } from "./accounts-page.js";
import { PLANS_PAGE_HTML } from "./plans-page.js";
import { AUDIT_PAGE_HTML } from "./audit-page.js";

const COOKIE = "admin_session";

const PAGES: Record<string, string> = {
  "/": LOGIN_PAGE_HTML,
  "/accounts": ACCOUNTS_PAGE_HTML,
  "/settings": SETTINGS_PAGE_HTML,
  "/plans": PLANS_PAGE_HTML,
  "/audit": AUDIT_PAGE_HTML,
  "/failures": FAILURES_PAGE_HTML,
  "/stats": STATS_PAGE_HTML,
};

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  throw new HttpError(400, `Потрібно вказати ${field}`);
}

async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (isLoginThrottled(`admin:${ip}`)) {
    sendJson(res, 429, { error: "Забагато спроб. Спробуйте пізніше." });
    return;
  }
  const { login, password } = await readJson(req);
  const adminId = typeof login === "string" && typeof password === "string"
    ? await checkAdminPassword(login, password)
    : null;
  if (!adminId) {
    recordFailedLogin(`admin:${ip}`);
    log("WARN", "Failed admin login", { ip, login: typeof login === "string" ? login : undefined });
    sendJson(res, 401, { error: "Невірний логін або пароль" });
    return;
  }
  const session = await createSession("admin", adminId);
  log("INFO", "Admin logged in", { adminId, ip });
  res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookie(req, COOKIE, session.token, session.maxAgeSec) });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  actor: Actor
): Promise<void> {
  const url = requestUrl(req);

  switch (route) {
    // --- Telegram reader session ---
    case "GET /api/account": {
      try {
        const account = await getAccount();
        sendJson(res, account ? 200 : 409, account ?? { error: "Вхід не виконано" });
      } catch (error) {
        log("WARN", "Failed to fetch Telegram account", { error: String(error) });
        sendJson(res, 502, { error: "Не вдалося звʼязатися з Telegram" });
      }
      return;
    }

    case "GET /api/state": {
      const recipients = await countRecipients().catch(() => null);
      sendJson(res, 200, { ...getAuthState(), recipients });
      return;
    }

    case "POST /api/login": {
      const { method, phone } = await readJson(req);
      if (method !== "qr" && method !== "phone") {
        sendJson(res, 400, { error: "Невідомий спосіб входу" });
        return;
      }
      const error = startLogin(method, typeof phone === "string" ? phone.trim() : undefined);
      sendJson(res, error ? 409 : 200, error ? { error } : { ok: true });
      return;
    }

    case "POST /api/submit": {
      const { value } = await readJson(req);
      const ok = typeof value === "string" && submitInput(value.trim());
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: "Немає чого надсилати" });
      return;
    }

    case "POST /api/cancel":
      await cancelLogin();
      sendJson(res, 200, { ok: true });
      return;

    // --- Channels ---
    case "GET /api/settings":
      sendJson(res, 200, getWatchConfigView());
      return;

    case "GET /api/channels/photo": {
      const name = url.searchParams.get("name") ?? "";
      const photo = await getChannelPhoto(name).catch((error) => {
        log("WARN", "Failed to download channel photo", { channel: name, error: String(error) });
        return null;
      });
      if (!photo) {
        sendJson(res, 404, { error: "Немає фото" });
        return;
      }
      // The URL carries the photo id, so a changed photo gets a new URL
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      res.end(photo);
      return;
    }

    case "POST /api/channels": {
      const value = requireString((await readJson(req)).value, "канал");
      const error = await addChannel(value);
      sendResult(res, error, getWatchConfigView());
      return;
    }

    case "DELETE /api/channels": {
      await removeChannel(requireString((await readJson(req)).value, "канал"));
      sendJson(res, 200, getWatchConfigView());
      return;
    }

    // --- AI parse log and stats ---
    case "GET /api/parse-failures":
      sendJson(res, 200, await listParseFailures());
      return;

    case "DELETE /api/parse-failures":
      await clearParseFailures();
      sendJson(res, 200, { ok: true });
      return;

    case "GET /api/stats":
      sendJson(res, 200, await getPostStats());
      return;

    case "DELETE /api/stats":
      await clearPostStats();
      sendJson(res, 200, { ok: true });
      return;

    // --- Accounts, users, subscriptions ---
    case "GET /api/overview":
      sendJson(res, 200, await getBusinessOverview());
      return;

    case "GET /api/accounts":
      sendJson(res, 200, await listAccounts(url.searchParams.get("q") ?? ""));
      return;

    case "GET /api/accounts/detail": {
      const id = url.searchParams.get("id") ?? "";
      if (!/^\d+$/.test(id)) throw new HttpError(400, "Некоректний ID");
      const account = await getAccountDetail(id);
      if (!account) {
        sendJson(res, 404, { error: "Акаунт не знайдено" });
        return;
      }
      const [filters, subscriptions, payments, audit] = await Promise.all([
        getFilters(id),
        listSubscriptions(id),
        listPayments(id),
        listAudit(50, "account", id),
      ]);
      sendJson(res, 200, { account, filters, subscriptions, payments, audit });
      return;
    }

    case "POST /api/accounts/grant": {
      const body = await readJson(req);
      const accountId = requireString(body.accountId, "акаунт");
      const plan = await getPlan(requireString(body.planId, "тариф"));
      if (!plan) throw new HttpError(400, "Тариф не знайдено");
      const periods = body.periods ?? 1;
      if (!Number.isInteger(periods) || periods < 1 || periods > 24) throw new HttpError(400, "Кількість періодів: від 1 до 24");
      const days = body.days === null || body.days === undefined ? plan.durationDays * periods : body.days;
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, "Кількість днів: від 1 до 3650");
      const amount = Number(body.amount ?? 0);
      if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, "Некоректна сума");
      const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : plan.currency;
      const method = typeof body.method === "string" ? body.method.slice(0, 32) : "cash";
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      if (!(await getAccountDetail(accountId))) throw new HttpError(404, "Акаунт не знайдено");

      await grantSubscription({
        accountId,
        planId: plan.id,
        kind: amount > 0 ? "paid" : "gift",
        source: "manual",
        days,
        payment: amount > 0 ? { amount, currency, method, note: note || undefined } : undefined,
      }, actor);
      log("INFO", "Subscription granted by admin", { accountId, plan: plan.code, days, amount, currency, adminId: actor.id });
      sendJson(res, 200, { ok: true });
      return;
    }

    case "POST /api/subscriptions/cancel": {
      const ok = await cancelSubscription(requireString((await readJson(req)).id, "період"), actor);
      sendResult(res, ok ? null : "Період не знайдено або вже скасовано");
      return;
    }

    case "POST /api/accounts/status": {
      const { accountId, status } = await readJson(req);
      sendResult(res, await setAccountStatus(requireString(accountId, "акаунт"), status, actor));
      return;
    }

    case "POST /api/accounts/transfer": {
      const { accountId, userId } = await readJson(req);
      sendResult(res, await transferOwnership(requireString(accountId, "акаунт"), requireString(userId, "користувача"), actor));
      return;
    }

    case "POST /api/accounts/move-user": {
      const { accountId, userId, role } = await readJson(req);
      const id = requireString(userId, "ID користувача");
      if (!/^\d+$/.test(id)) throw new HttpError(400, "Некоректний ID користувача");
      sendResult(res, await moveUserToAccount(requireString(accountId, "акаунт"), id, role, actor));
      return;
    }

    case "POST /api/accounts/remove-member": {
      const { accountId, userId } = await readJson(req);
      sendResult(res, await adminRemoveMember(requireString(accountId, "акаунт"), requireString(userId, "користувача"), actor));
      return;
    }

    case "GET /api/users":
      sendJson(res, 200, await searchUsers(url.searchParams.get("q") ?? ""));
      return;

    case "POST /api/users/status": {
      const { userId, status } = await readJson(req);
      if (status !== "active" && status !== "blocked") throw new HttpError(400, "Невідомий статус");
      const id = requireString(userId, "користувача");
      await setUserStatus(id, status);
      await audit(actor, status === "blocked" ? "user.blocked" : "user.unblocked", { type: "user", id });
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- Plans, admins, audit ---
    case "GET /api/plans":
      sendJson(res, 200, await listPlans());
      return;

    case "POST /api/plans": {
      const body = await readJson(req);
      sendResult(res, await savePlan(typeof body.id === "string" && body.id ? body.id : null, body, actor));
      return;
    }

    case "GET /api/admins":
      sendJson(res, 200, await listAdmins());
      return;

    case "POST /api/admins": {
      const { login, password } = await readJson(req);
      const error = await createAdmin(String(login ?? ""), String(password ?? ""));
      if (!error) {
          await audit(actor, "admin.created", null, { login });
      }
      sendResult(res, error);
      return;
    }

    case "POST /api/admins/password": {
      const { password } = await readJson(req);
      sendResult(res, await changeAdminPassword(actor.id!, String(password ?? "")));
      return;
    }

    case "GET /api/audit":
      sendJson(res, 200, await listAudit());
      return;

    default:
      sendJson(res, 404, { error: "Not found" });
  }
}

export async function handleAdminRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = requestUrl(req).pathname;
  const route = `${req.method} ${path}`;

  if (route === "GET /login") {
    sendHtml(res, ADMIN_LOGIN_PAGE_HTML);
    return;
  }
  if (route === "POST /auth/login") {
    await handleLogin(req, res);
    return;
  }
  if (route === "GET /logout") {
    await destroySession(getCookie(req, COOKIE));
    redirect(res, "/login", { "Set-Cookie": clearCookie(req, COOKIE) });
    return;
  }

  const adminId = await resolveSession("admin", getCookie(req, COOKIE));
  if (!adminId) {
    if (req.method === "GET" && PAGES[path]) redirect(res, "/login");
    else sendJson(res, 401, { error: "Потрібно увійти" });
    return;
  }

  if (req.method === "GET" && PAGES[path]) {
    sendHtml(res, PAGES[path]);
    return;
  }
  await handleAuthorized(req, res, route, { type: "admin", id: adminId });
}
