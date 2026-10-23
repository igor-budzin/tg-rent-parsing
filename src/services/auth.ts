import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { pool } from "./db.js";
import { ADMIN_LOGIN, ADMIN_PASSWORD, BOT_TOKEN } from "../config.js";
import { log } from "../utils/logger.js";
import { generateTotpSecret, totpUrl, verifyTotp } from "./totp.js";
import { audit, SYSTEM } from "./audit.js";

// Sessions for both web apps, Telegram sign-in for users and passwords for admins.
// Only hashes of session and login tokens are stored, so a database leak can't be used to log in.

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type SessionKind = "user" | "admin";

const SESSION_TTL_DAYS: Record<SessionKind, number> = { user: 30, admin: 1 };
const LOGIN_TOKEN_TTL_MIN = 15;
// Telegram login data older than this is rejected, so leaked login data can't be replayed for long.
// The page sends it right after Telegram redirects back, so an hour only allows for slow devices
// and clock skew.
const TELEGRAM_AUTH_MAX_AGE_SEC = 60 * 60;

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

// Checked when the login doesn't exist, so the response time doesn't reveal which logins do
let dummyHash: Promise<string> | null = null;

// Owners also manage admins and the Telegram reader login
export type AdminRole = "owner" | "admin";

export interface Admin {
  id: string;
  login: string;
  role: AdminRole;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function toAdmin(row: any): Admin {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    disabled: Boolean(row.disabled_at),
    totpEnabled: Boolean(row.totp_enabled_at),
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

// "code_required": the password is right, and the admin has 2FA on but sent no code.
// "code_locked": the password is right, but too many wrong codes were sent, see checkTotpCode.
export type AdminLoginResult = { adminId: string } | { error: "invalid" | "code_required" | "code_locked" };

// Marks the code's time step used; false when it or a later one already was (a replayed code)
async function consumeTotpStep(adminId: string, step: number): Promise<boolean> {
  const result = await pool.query(
    "UPDATE admins SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
    [adminId, step]
  );
  return result.rowCount === 1;
}

// Wrong codes in a row an admin may send freely; after that each next code has to wait, twice as
// long after every further wrong one (1, 2, 4… minutes, up to a day), so guessing the 6 digits
// takes years rather than weeks
const TOTP_FREE_FAILURES = 5;
const TOTP_MAX_LOCK_MIN = 24 * 60;
export const TOTP_LOCKED_TEXT = "Забагато невірних кодів. Спробуйте пізніше.";

// Checks a code for an admin with 2FA on. Counted in the database, so restarts don't reset it.
// The attempt is counted as failed before the code is checked, in one UPDATE: the row lock makes
// parallel requests wait for each other, so they can't all slip in before the lock starts.
async function checkTotpCode(adminId: string, secret: string, code: string): Promise<"ok" | "invalid" | "locked"> {
  const taken = await pool.query<{ totp_failures: number }>(
    `UPDATE admins SET totp_failures = totp_failures + 1,
       totp_locked_until = CASE WHEN totp_failures + 1 >= $2
         THEN NOW() + LEAST(power(2, totp_failures + 1 - $2), $3) * INTERVAL '1 minute' END
     WHERE id = $1 AND (totp_locked_until IS NULL OR totp_locked_until <= NOW())
     RETURNING totp_failures`,
    [adminId, TOTP_FREE_FAILURES, TOTP_MAX_LOCK_MIN]
  );
  if (taken.rows.length === 0) return "locked";

  const step = verifyTotp(secret, code);
  if (step !== null && (await consumeTotpStep(adminId, step))) {
    await pool.query("UPDATE admins SET totp_failures = 0, totp_locked_until = NULL WHERE id = $1", [adminId]);
    return "ok";
  }
  const failures = taken.rows[0].totp_failures;
  log("WARN", "Wrong two-factor code", { adminId, failures });
  if (failures === TOTP_FREE_FAILURES) {
    await audit(SYSTEM, "admin.totp_locked", { type: "admin", id: adminId }, { failures });
  }
  return "invalid";
}

// Confirms that whoever holds an admin session also knows the password, and the current code when
// 2FA is on, so a stolen session alone can't take the account over. Shares the brute-force limit
// with the login form, per admin.
async function reauthenticate(adminId: string, password: string, code: string | undefined): Promise<string | null> {
  const release = takeLoginAttempt(`admin-reauth:${adminId}`);
  if (!release) return "Забагато спроб. Спробуйте пізніше.";
  const result = await pool.query("SELECT password_hash, totp_secret, totp_enabled_at FROM admins WHERE id = $1", [adminId]);
  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) return "Невірний поточний пароль";
  release();
  if (row.totp_enabled_at) {
    if (!code?.trim()) return "Введіть код із застосунку автентифікації";
    const check = await checkTotpCode(adminId, row.totp_secret, code);
    if (check === "locked") return TOTP_LOCKED_TEXT;
    if (check === "invalid") return "Невірний код";
  }
  return null;
}

// A disabled admin gets the same answer as a wrong password
export async function checkAdminLogin(login: string, password: string, code: string | undefined): Promise<AdminLoginResult> {
  const result = await pool.query(
    "SELECT id, password_hash, disabled_at, totp_secret, totp_enabled_at FROM admins WHERE lower(login) = lower($1)",
    [login.trim()]
  );
  const admin = result.rows[0];
  if (!admin) {
    await verifyPassword(password, await (dummyHash ??= hashPassword(randomBytes(16).toString("hex"))));
    return { error: "invalid" };
  }
  if (!(await verifyPassword(password, admin.password_hash)) || admin.disabled_at) return { error: "invalid" };
  if (admin.totp_enabled_at) {
    if (!code) return { error: "code_required" };
    const check = await checkTotpCode(admin.id, admin.totp_secret, code);
    if (check !== "ok") return { error: check === "locked" ? "code_locked" : "invalid" };
  }
  await pool.query("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [admin.id]);
  return { adminId: admin.id };
}

export async function getAdmin(adminId: string): Promise<Admin | null> {
  const result = await pool.query("SELECT * FROM admins WHERE id = $1", [adminId]);
  return result.rows[0] ? toAdmin(result.rows[0]) : null;
}

export async function listAdmins(): Promise<Admin[]> {
  const result = await pool.query("SELECT * FROM admins ORDER BY id");
  return result.rows.map(toAdmin);
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

// Needs the current password (and code, with 2FA on), see reauthenticate
export async function changeAdminPassword(
  adminId: string,
  currentPassword: string,
  password: string,
  code: string | undefined
): Promise<string | null> {
  if (password.length < MIN_PASSWORD_LENGTH) return `Пароль має містити щонайменше ${MIN_PASSWORD_LENGTH} символів`;
  const reauthError = await reauthenticate(adminId, currentPassword, code);
  if (reauthError) return reauthError;
  await pool.query("UPDATE admins SET password_hash = $2 WHERE id = $1", [adminId, await hashPassword(password)]);
  await destroyAllSessions("admin", adminId);
  return null;
}

// Owners can't change or disable themselves, so there is always at least one active owner
export async function setAdminRole(actorId: string, adminId: string, role: unknown): Promise<string | null> {
  if (role !== "owner" && role !== "admin") return "Невідома роль";
  if (adminId === actorId) return "Власну роль змінити не можна";
  const result = await pool.query("UPDATE admins SET role = $2 WHERE id = $1", [adminId, role]);
  return result.rowCount === 0 ? "Адміністратора не знайдено" : null;
}

export async function setAdminDisabled(actorId: string, adminId: string, disabled: boolean): Promise<string | null> {
  if (adminId === actorId) return "Себе вимкнути не можна";
  const result = await pool.query(
    "UPDATE admins SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, NOW()) END WHERE id = $1",
    [adminId, disabled]
  );
  if (result.rowCount === 0) return "Адміністратора не знайдено";
  if (disabled) await destroyAllSessions("admin", adminId);
  return null;
}

// --- Admin two-factor sign-in (TOTP) ---

const TOTP_ISSUER = "Оренда — адмінка";

// Starts over each time, so a half-finished setup can simply be redone. Needs the password, so a
// stolen session can't tie the account to the thief's phone and lock its owner out.
export async function startTotpSetup(adminId: string, password: string): Promise<{ secret: string; url: string } | string> {
  const admin = await getAdmin(adminId);
  if (!admin) return "Адміністратора не знайдено";
  if (admin.totpEnabled) return "Двофакторний вхід уже увімкнено";
  const reauthError = await reauthenticate(adminId, password, undefined);
  if (reauthError) return reauthError;
  const secret = generateTotpSecret();
  await pool.query("UPDATE admins SET totp_secret = $2, totp_last_step = NULL WHERE id = $1", [adminId, secret]);
  return { secret, url: totpUrl(secret, admin.login, TOTP_ISSUER) };
}

// The first code proves the app was set up with the secret
export async function enableTotp(adminId: string, code: string): Promise<string | null> {
  const result = await pool.query("SELECT totp_secret, totp_enabled_at FROM admins WHERE id = $1", [adminId]);
  const row = result.rows[0];
  if (!row?.totp_secret || row.totp_enabled_at) return "Спершу почніть налаштування";
  const step = verifyTotp(row.totp_secret, code);
  if (step === null || !(await consumeTotpStep(adminId, step))) return "Невірний код";
  await pool.query("UPDATE admins SET totp_enabled_at = NOW() WHERE id = $1", [adminId]);
  return null;
}

// Needs a current code, so a stolen session alone can't turn 2FA off
export async function disableTotp(adminId: string, code: string): Promise<string | null> {
  const result = await pool.query("SELECT totp_secret, totp_enabled_at FROM admins WHERE id = $1", [adminId]);
  const row = result.rows[0];
  if (!row?.totp_enabled_at) return "Двофакторний вхід не увімкнено";
  const check = await checkTotpCode(adminId, row.totp_secret, code);
  if (check === "locked") return TOTP_LOCKED_TEXT;
  if (check === "invalid") return "Невірний код";
  await pool.query("UPDATE admins SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1", [adminId]);
  return null;
}

// For an admin who lost their phone: an owner turns 2FA off, the admin sets it up again
export async function resetTotp(actorId: string, adminId: string): Promise<string | null> {
  if (adminId === actorId) return "Свій двофакторний вхід вимикайте кодом із застосунку";
  const result = await pool.query(
    `UPDATE admins SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
       totp_failures = 0, totp_locked_until = NULL WHERE id = $1`,
    [adminId]
  );
  return result.rowCount === 0 ? "Адміністратора не знайдено" : null;
}

// Placeholders from .env.example and docs, which someone may deploy unchanged
const WEAK_BOOTSTRAP_PASSWORDS = new Set(["change_me", "changeme", "change_me_please", "password", "admin", "your_password_here"]);

// The first admin comes from ADMIN_LOGIN / ADMIN_PASSWORD and is the owner; the env vars are
// ignored once one exists
export async function bootstrapAdmin(): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM admins LIMIT 1");
  if (existing.rows.length > 0) return;
  if (!ADMIN_PASSWORD) {
    log("WARN", "No admins yet and ADMIN_PASSWORD is empty: the admin app can't be used");
    return;
  }
  // This admin is an owner, so a guessable password would hand over the whole app
  if (ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH || WEAK_BOOTSTRAP_PASSWORDS.has(ADMIN_PASSWORD.toLowerCase())) {
    log("ERROR", `ADMIN_PASSWORD is too weak (placeholder or under ${MIN_PASSWORD_LENGTH} characters): no admin created, set a strong one and restart`);
    return;
  }
  await pool.query("INSERT INTO admins (login, password_hash, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [
    ADMIN_LOGIN,
    await hashPassword(ADMIN_PASSWORD),
  ]);
  log("INFO", "Created the first admin from env vars", { login: ADMIN_LOGIN });
}

// --- Brute-force protection for login endpoints ---

// Per client IP
export const FAILED_LOGIN_LIMIT = 10;
// Per admin login, against guessing spread over many IPs; higher, since anyone can use it up to
// lock that admin out for the rest of the window
export const FAILED_LOGIN_LIMIT_PER_ACCOUNT = 30;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Bounds memory when an attacker cycles through keys (IPs, made-up logins)
const MAX_TRACKED_KEYS = 10_000;
const failedLogins = new Map<string, { count: number; firstAt: number }>();

function isExpired(entry: { firstAt: number }, now: number): boolean {
  return now - entry.firstAt > FAILED_LOGIN_WINDOW_MS;
}

function isLoginThrottled(key: string, limit: number): boolean {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (isExpired(entry, Date.now())) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= limit;
}

function makeRoom(now: number): void {
  for (const [key, entry] of failedLogins) {
    if (isExpired(entry, now)) failedLogins.delete(key);
  }
  // Still nearly full: drop the oldest tenth (a Map iterates in insertion order), so a flood of
  // new keys doesn't rescan the whole map on every request
  for (const key of failedLogins.keys()) {
    if (failedLogins.size < MAX_TRACKED_KEYS * 0.9) break;
    failedLogins.delete(key);
  }
}

function recordFailedLogin(key: string): { count: number; firstAt: number } {
  const now = Date.now();
  const entry = failedLogins.get(key);
  if (entry && !isExpired(entry, now)) {
    entry.count++;
    return entry;
  }
  failedLogins.delete(key);
  if (failedLogins.size >= MAX_TRACKED_KEYS) makeRoom(now);
  const fresh = { count: 1, firstAt: now };
  failedLogins.set(key, fresh);
  return fresh;
}

// Counts the attempt as failed before it's checked, in one synchronous step: otherwise parallel
// requests would all pass the limit while the slow password check runs. Returns null when the key
// is over its limit, else a function that takes the attempt back once it turns out not to have
// failed.
export function takeLoginAttempt(key: string, limit = FAILED_LOGIN_LIMIT): (() => void) | null {
  if (isLoginThrottled(key, limit)) return null;
  const entry = recordFailedLogin(key);
  let released = false;
  return () => {
    // Only while the same window is running; a new window never counted this attempt
    if (released || failedLogins.get(key) !== entry) return;
    released = true;
    entry.count--;
  };
}

export async function deleteExpiredAuthRows(): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
  await pool.query("DELETE FROM login_tokens WHERE expires_at < NOW() - INTERVAL '1 day'");
}
