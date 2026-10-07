import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ADMIN_PASSWORD, PORT } from "../config.js";
import { log } from "../utils/logger.js";
import {
  getAuthState,
  startLogin,
  submitInput,
  cancelLogin,
  getAccount,
} from "../services/telegram-auth.js";
import { countActiveSubscribers, listSubscribers } from "../services/subscribers.js";
import { LOGIN_PAGE_HTML } from "./login-page.js";
import { SUBSCRIBERS_PAGE_HTML } from "./subscribers-page.js";
import { SETTINGS_PAGE_HTML } from "./settings-page.js";
import {
  getWatchConfigView,
  addKeyword,
  removeKeyword,
  addChannel,
  removeChannel,
  getChannelPhoto,
} from "../services/watch-config.js";

const MAX_BODY_BYTES = 10_000;

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const password = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return password.length === expected.length && timingSafeEqual(password, expected);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error("Body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="tg-rent-parsing"' });
    res.end("Authentication required");
    return;
  }

  const route = `${req.method} ${req.url?.split("?")[0]}`;

  switch (route) {
    case "GET /":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOGIN_PAGE_HTML);
      return;

    case "GET /subscribers":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUBSCRIBERS_PAGE_HTML);
      return;

    case "GET /api/subscribers":
      sendJson(res, 200, await listSubscribers());
      return;

    case "GET /settings":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SETTINGS_PAGE_HTML);
      return;

    case "GET /api/settings":
      sendJson(res, 200, getWatchConfigView());
      return;

    case "GET /api/channels/photo": {
      const name = new URL(req.url ?? "", "http://localhost").searchParams.get("name") ?? "";
      const photo = await getChannelPhoto(name).catch((error) => {
        log("WARN", "Failed to download channel photo", { channel: name, error: String(error) });
        return null;
      });
      if (!photo) {
        sendJson(res, 404, { error: "No photo" });
        return;
      }
      // The URL carries the photo id, so a changed photo gets a new URL
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      res.end(photo);
      return;
    }

    case "POST /api/keywords":
    case "POST /api/channels": {
      const { value } = await readJson(req);
      if (typeof value !== "string") {
        sendJson(res, 400, { error: "Value is required" });
        return;
      }
      const add = route === "POST /api/keywords" ? addKeyword : addChannel;
      const error = await add(value);
      sendJson(res, error ? 400 : 200, error ? { error } : getWatchConfigView());
      return;
    }

    case "DELETE /api/keywords":
    case "DELETE /api/channels": {
      const { value } = await readJson(req);
      if (typeof value !== "string") {
        sendJson(res, 400, { error: "Value is required" });
        return;
      }
      await (route === "DELETE /api/keywords" ? removeKeyword : removeChannel)(value);
      sendJson(res, 200, getWatchConfigView());
      return;
    }

    case "GET /api/account": {
      try {
        const account = await getAccount();
        sendJson(res, account ? 200 : 409, account ?? { error: "Not logged in" });
      } catch (error) {
        log("WARN", "Failed to fetch Telegram account", { error: String(error) });
        sendJson(res, 502, { error: "Could not reach Telegram" });
      }
      return;
    }

    case "GET /api/state": {
      const subscribers = await countActiveSubscribers().catch(() => null);
      sendJson(res, 200, { ...getAuthState(), subscribers });
      return;
    }

    case "POST /api/login": {
      const { method, phone } = await readJson(req);
      if (method !== "qr" && method !== "phone") {
        sendJson(res, 400, { error: "Unknown login method" });
        return;
      }
      const error = startLogin(method, typeof phone === "string" ? phone.trim() : undefined);
      sendJson(res, error ? 409 : 200, error ? { error } : { ok: true });
      return;
    }

    case "POST /api/submit": {
      const { value } = await readJson(req);
      const ok = typeof value === "string" && submitInput(value.trim());
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: "Nothing to submit" });
      return;
    }

    case "POST /api/cancel":
      await cancelLogin();
      sendJson(res, 200, { ok: true });
      return;

    default:
      sendJson(res, 404, { error: "Not found" });
  }
}

export function startWebServer(): void {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log("ERROR", "Web request failed", { url: req.url, error: String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    });
  });

  server.listen(PORT, () => {
    log("INFO", `Web UI listening on port ${PORT}`);
  });
}
