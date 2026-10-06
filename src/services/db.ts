import pg from "pg";
import { DATABASE_URL } from "../config.js";
import { log } from "../utils/logger.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unsubscribed_at TIMESTAMPTZ
    )
  `);
  // Single-row table holding the Telegram user session
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_session (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      session TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  log("DEBUG", "Database tables ready");
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
