import { pool } from "./db.js";

export async function loadSession(): Promise<string> {
  const result = await pool.query<{ session: string }>(
    "SELECT session FROM telegram_session WHERE id = 1"
  );
  return result.rows[0]?.session ?? "";
}

export async function saveSession(session: string): Promise<void> {
  await pool.query(
    `INSERT INTO telegram_session (id, session) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET session = EXCLUDED.session, updated_at = NOW()`,
    [session]
  );
}

export async function deleteSession(): Promise<void> {
  await pool.query("DELETE FROM telegram_session WHERE id = 1");
}
