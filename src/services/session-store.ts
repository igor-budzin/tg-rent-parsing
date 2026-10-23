import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pool } from "./db.js";
import { IS_PRODUCTION, TELEGRAM_SESSION_KEY } from "../config.js";
import { log } from "../utils/logger.js";

// The session string gives full access to the reader's Telegram account, so it's stored
// encrypted (AES-256-GCM) when TELEGRAM_SESSION_KEY is set. Plain-text rows, saved without a key
// or before encryption existed, are still read; the next start saves them encrypted.

const PREFIX = "enc:v1:";
// Ties the ciphertext to this use, so it can't be passed off as another encrypted value
const AAD = Buffer.from("telegram_session");
const key = TELEGRAM_SESSION_KEY ? Buffer.from(TELEGRAM_SESSION_KEY, "base64") : null;

// Checked on start, so a malformed key fails loudly instead of at the first save. In production
// the key is required: a plain-text session in a leaked backup would give away the account.
export function sessionKeyError(): string | null {
  if (key && key.length !== 32) return "TELEGRAM_SESSION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)";
  if (!key && IS_PRODUCTION) {
    return "TELEGRAM_SESSION_KEY must be set in production (openssl rand -base64 32); without it the Telegram session is stored unencrypted";
  }
  return null;
}

function encrypt(session: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(":");
}

function decrypt(stored: string, key: Buffer): string {
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// An unreadable session (key missing or changed) counts as no session, so the app asks for a
// new login in the admin app instead of crashing on every start
export async function loadSession(): Promise<string> {
  const result = await pool.query<{ session: string }>(
    "SELECT session FROM telegram_session WHERE id = 1"
  );
  const stored = result.rows[0]?.session ?? "";
  if (!stored.startsWith(PREFIX)) {
    // Saved before the key was set; it's saved encrypted once the client connects with it
    if (stored && key) log("WARN", "Saved Telegram session is unencrypted; it will be re-saved encrypted");
    return stored;
  }
  if (!key) {
    log("ERROR", "Saved Telegram session is encrypted but TELEGRAM_SESSION_KEY is not set; log in again or set the key");
    return "";
  }
  try {
    return decrypt(stored, key);
  } catch {
    log("ERROR", "Could not decrypt the saved Telegram session (wrong TELEGRAM_SESSION_KEY?); log in again or restore the key");
    return "";
  }
}

export async function saveSession(session: string): Promise<void> {
  if (!key) log("WARN", "TELEGRAM_SESSION_KEY is not set: the Telegram session is stored unencrypted");
  await pool.query(
    `INSERT INTO telegram_session (id, session) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET session = EXCLUDED.session, updated_at = NOW()`,
    [key ? encrypt(session, key) : session]
  );
}

export async function deleteSession(): Promise<void> {
  await pool.query("DELETE FROM telegram_session WHERE id = 1");
}
