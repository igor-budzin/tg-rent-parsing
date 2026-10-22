import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { pool } from "./db.js";
import { ADMIN_LOGIN, ADMIN_PASSWORD, BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";

// Sessions for both web apps, Telegram sign-in for users and passwords for admins.
// Only hashes of session and login tokens are stored, so a database leak can't be used to log in.

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type SessionKind = "user" | "admin";

const SESSION_TTL_DAYS: Record<SessionKind, number> = { user: 30, admin: 1 };
const LOGIN_TOKEN_TTL_MIN = 15;
// Telegram login data older than this is rejected, so a leaked login URL can't be replayed for long
const TELEGRAM_AUTH_MAX_AGE_SEC = 24 * 60 * 60;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createSession(kind: SessionKind, subjectId: string): Promise<{ token: string; maxAgeSec: number }> {
  const token = randomBytes(32).toString("base64url");
  const days = SESSION_TTL_DAYS[kind];
  await pool.query(
    `INSERT INTO sessions (token_hash, kind, subject_id, expires_at)
     VALUES ($1, $2, $3, NOW() + $4 * INTERVAL '1 day')`,
    [sha256(token), kind, subjectId, days]
  );
  return { token, maxAgeSec: days * 86_400 };
}

export async function resolveSession(kind: SessionKind, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const result = await pool.query<{ subject_id: string }>(
    "SELECT subject_id FROM sessions WHERE token_hash = $1 AND kind = $2 AND expires_at > NOW()",
    [sha256(token), kind]
  );
  return result.rows[0]?.subject_id ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

export async function destroyAllSessions(kind: SessionKind, subjectId: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE kind = $1 AND subject_id = $2", [kind, subjectId]);
}

// --- Telegram Login Widget (https://core.telegram.org/widgets/login#checking-authorization) ---

export interface TelegramAuthData {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export function verifyTelegramLogin(params: URLSearchParams): TelegramAuthData | null {
  const hash = params.get("hash");
  const id = params.get("id");
  const authDate = Number(params.get("auth_date"));
  if (!hash || !id || !authDate) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHash("sha256").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Date.now() / 1000 - authDate > TELEGRAM_AUTH_MAX_AGE_SEC) return null;

  return {
    id,
    username: params.get("username") ?? undefined,
    firstName: params.get("first_name") ?? undefined,
    lastName: params.get("last_name") ?? undefined,
  };
}

// --- One-time login links sent by the bot ---

export async function createLoginToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + $3 * INTERVAL '1 minute')",
    [sha256(token), userId, LOGIN_TOKEN_TTL_MIN]
  );
  return token;
}

export async function consumeLoginToken(token: string): Promise<string | null> {
  const result = await pool.query<{ user_id: string }>(
    `UPDATE login_tokens SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [sha256(token)]
  );
  return result.rows[0]?.user_id ?? null;
}

// --- Admin passwords ---

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(key, expected);
}

export async function checkAdminPassword(login: string, password: string): Promise<string | null> {
  const result = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM admins WHERE lower(login) = lower($1)",
    [login.trim()]
  );
  const admin = result.rows[0];
  if (!admin || !(await verifyPassword(password, admin.password_hash))) return null;
  await pool.query("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [admin.id]);
  return admin.id;
}

export async function getAdminLogin(adminId: string): Promise<string | null> {
  const result = await pool.query<{ login: string }>("SELECT login FROM admins WHERE id = $1", [adminId]);
  return result.rows[0]?.login ?? null;
}

export async function listAdmins(): Promise<{ id: string; login: string; createdAt: string; lastLoginAt: string | null }[]> {
  const result = await pool.query("SELECT id, login, created_at, last_login_at FROM admins ORDER BY id");
  return result.rows.map((row) => ({
    id: row.id,
    login: row.login,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  }));
}

export const MIN_PASSWORD_LENGTH = 10;

export async function createAdmin(login: string, password: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login)) return "Логін: 3–32 символи a-z, 0-9, _ . -";
  if (password.length < MIN_PASSWORD_LENGTH) return `Пароль має містити щонайменше ${MIN_PASSWORD_LENGTH} символів`;
  try {
    await pool.query("INSERT INTO admins (login, password_hash) VALUES ($1, $2)", [login, await hashPassword(password)]);
    return null;
  } catch (error: any) {
    if (error?.code === "23505") return "Такий логін уже є";
    throw error;
  }
}

export async function changeAdminPassword(adminId: string, password: string): Promise<string | null> {
  if (password.length < MIN_PASSWORD_LENGTH) return `Пароль має містити щонайменше ${MIN_PASSWORD_LENGTH} символів`;
  await pool.query("UPDATE admins SET password_hash = $2 WHERE id = $1", [adminId, await hashPassword(password)]);
  await destroyAllSessions("admin", adminId);
  return null;
}

// The first admin comes from ADMIN_LOGIN / ADMIN_PASSWORD; the env vars are ignored once one exists
export async function bootstrapAdmin(): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM admins LIMIT 1");
  if (existing.rows.length > 0) return;
  if (!ADMIN_PASSWORD) {
    log("WARN", "No admins yet and ADMIN_PASSWORD is empty: the admin app can't be used");
    return;
  }
  await pool.query("INSERT INTO admins (login, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    ADMIN_LOGIN,
    await hashPassword(ADMIN_PASSWORD),
  ]);
  log("INFO", "Created the first admin from env vars", { login: ADMIN_LOGIN });
}

// --- Brute-force protection for login endpoints ---

const FAILED_LOGIN_LIMIT = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; firstAt: number }>();

export function isLoginThrottled(key: string): boolean {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > FAILED_LOGIN_WINDOW_MS) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= FAILED_LOGIN_LIMIT;
}

export function recordFailedLogin(key: string): void {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.firstAt > FAILED_LOGIN_WINDOW_MS) {
    failedLogins.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count++;
  }
}

export async function deleteExpiredAuthRows(): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
  await pool.query("DELETE FROM login_tokens WHERE expires_at < NOW() - INTERVAL '1 day'");
}
