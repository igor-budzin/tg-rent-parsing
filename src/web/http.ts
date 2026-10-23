import http from "node:http";
import { createHash } from "node:crypto";
import { ADMIN_URL, APP_URL, TRUSTED_PROXY_HOPS } from "../config.js";

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

// Only the page's own inline scripts may run, each allowed by its hash, so injected markup can't
// execute script even if some output escaping is missed. Inline styles stay allowed: the pages
// use style attributes, and CSS can't run code.
function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, code]) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`
  );
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ") || "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function sendHtml(res: http.ServerResponse, html: string, headers: http.OutgoingHttpHeaders = {}, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy(html),
    ...headers,
  });
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

const MAX_BIGINT = 9223372036854775807n;

// A database id from a request: digits that fit BIGINT. Anything else is a 400 here rather than
// a Postgres cast error and a 500 later.
export function requireId(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,19}$/.test(text) || BigInt(text) > MAX_BIGINT) throw new HttpError(400, `Некоректний ${field}`);
  return text;
}

export function requestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function hostOf(req: http.IncomingMessage): string {
  return (req.headers.host ?? "").trim().toLowerCase();
}

// Hosts configured with an https:// URL are served over HTTPS whatever the proxy headers say
const HTTPS_HOSTS = new Set(
  [APP_URL, ADMIN_URL].map((u) => new URL(u)).filter((u) => u.protocol === "https:").map((u) => u.host.toLowerCase())
);

export function isHttps(req: http.IncomingMessage): boolean {
  return HTTPS_HOSTS.has(hostOf(req)) || req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() === "https";
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
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// Browsers then refuse plain HTTP to this host for a year, so session cookies can't leak over it
export const HSTS_HEADER = "max-age=31536000";
