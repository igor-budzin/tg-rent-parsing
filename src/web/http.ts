import http from "node:http";
import { TRUSTED_PROXY_HOPS } from "../config.js";

// Request and response helpers shared by the user app and the admin app

const MAX_BODY_BYTES = 10_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: http.ServerResponse, html: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

export function redirect(res: http.ServerResponse, location: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

// Sends `{ error }` with 400 when there's an error message, otherwise the given body
export function sendResult(res: http.ServerResponse, error: string | null, body: unknown = { ok: true }): void {
  sendJson(res, error ? 400 : 200, error ? { error } : body);
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
  }
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Некоректний JSON");
  }
}

export function requestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function hostOf(req: http.IncomingMessage): string {
  return (req.headers.host ?? "").trim().toLowerCase();
}

function isHttps(req: http.IncomingMessage): boolean {
  return req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() === "https";
}

// Proxies append the address they saw, so only the rightmost TRUSTED_PROXY_HOPS entries can be
// trusted; anything left of them is whatever the client sent
export function clientIp(req: http.IncomingMessage): string {
  const socketIp = req.socket.remoteAddress || "unknown";
  if (TRUSTED_PROXY_HOPS <= 0) return socketIp;
  const hops = (req.headers["x-forwarded-for"]?.toString() ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  return hops[hops.length - TRUSTED_PROXY_HOPS] || socketIp;
}

export function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

// Host-only cookie (no Domain), so the user app and the admin app never share sessions
export function sessionCookie(req: http.IncomingMessage, name: string, value: string, maxAgeSec: number): string {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearCookie(req: http.IncomingMessage, name: string): string {
  return sessionCookie(req, name, "", 0);
}

// CSRF protection for cookie-authenticated APIs: browsers always send Origin on cross-site
// POST/PUT/DELETE, and a JSON body can't be sent cross-site without a CORS preflight
export function isSafeMutation(req: http.IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== hostOf(req)) return false;
    } catch {
      return false;
    }
  }
  const type = req.headers["content-type"] ?? "";
  return type.startsWith("application/json") || req.headers["content-length"] === "0" || !req.headers["content-length"];
}

export const SECURITY_HEADERS: http.OutgoingHttpHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
