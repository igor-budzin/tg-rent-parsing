import http from "node:http";
import { ADMIN_URL, APP_URL, PORT } from "../config.js";
import { log } from "../utils/logger.js";
import { pool } from "../services/db.js";
import { handleAdminRequest } from "./admin/routes.js";
import { handleAppRequest } from "./app/routes.js";
import { sendJson, hostOf, isSafeMutation, isHttps, HttpError, SECURITY_HEADERS, HSTS_HEADER } from "./http.js";

// One server for both apps: requests are routed by Host, so each app can get its own
// (sub)domain pointing at the same service. Cookies are host-only, so the apps never share
// sessions.

const ADMIN_HOST = new URL(ADMIN_URL).host.toLowerCase();
const APP_HOST = new URL(APP_URL).host.toLowerCase();

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value!);
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", HSTS_HEADER);

  // Reachable on any host, for the platform's health checks
  if (req.url === "/health") {
    await pool.query("SELECT 1");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isSafeMutation(req)) {
    sendJson(res, 403, { error: "Запит з іншого сайту відхилено" });
    return;
  }

  const host = hostOf(req);
  if (host === ADMIN_HOST) return handleAdminRequest(req, res);
  if (host === APP_HOST) return handleAppRequest(req, res);

  sendJson(res, 404, { error: "Unknown host" });
}

export function startWebServer(): http.Server {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        return;
      }
      // Path only: query strings can hold one-time login tokens
      log("ERROR", "Web request failed", { method: req.method, path: (req.url ?? "").split("?")[0], error: String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "Внутрішня помилка" });
    });
  });

  server.listen(PORT, () => {
    log("INFO", `Web server listening on port ${PORT}`, { app: APP_URL, admin: ADMIN_URL });
  });
  return server;
}
