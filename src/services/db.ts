import pg from "pg";
import { DATABASE_URL, ENV_CHANNELS, ENV_KEYWORDS } from "../config.js";
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
  await pool.query("ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_name TEXT");
  // Single-row table holding the Telegram user session
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_session (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      session TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await initWatchSettingsTables();
  log("DEBUG", "Database tables ready");
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [name]
  );
  return result.rows[0].exists;
}

// Keywords and channels are edited from the web UI. When a table is first created it is
// seeded from the old KEYWORDS / CHANNELS_TO_WATCH env vars, which are ignored afterwards.
async function initWatchSettingsTables(): Promise<void> {
  const tables = [
    { name: "keywords", column: "keyword", seed: ENV_KEYWORDS },
    { name: "channels", column: "name", seed: ENV_CHANNELS },
  ];

  for (const table of tables) {
    const isNew = !(await tableExists(table.name));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table.name} (
        ${table.column} TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${table.name}_unique ON ${table.name} (lower(${table.column}))`
    );

    if (isNew && table.seed.length > 0) {
      for (const value of table.seed) {
        await pool.query(
          `INSERT INTO ${table.name} (${table.column}) VALUES ($1) ON CONFLICT DO NOTHING`,
          [value]
        );
      }
      log("INFO", `Imported ${table.seed.length} ${table.name} from env vars`);
    }
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
