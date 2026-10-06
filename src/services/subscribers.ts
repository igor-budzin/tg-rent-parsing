import { pool } from "./db.js";

export interface SubscriberInfo {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface Subscriber extends SubscriberInfo {
  active: boolean;
  subscribedAt: string;
  unsubscribedAt: string | null;
}

export async function addSubscriber(info: SubscriberInfo): Promise<void> {
  await pool.query(
    `INSERT INTO subscribers (chat_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, subscribers.username),
       first_name = COALESCE(EXCLUDED.first_name, subscribers.first_name),
       last_name = COALESCE(EXCLUDED.last_name, subscribers.last_name),
       active = TRUE,
       subscribed_at = CASE WHEN subscribers.active THEN subscribers.subscribed_at ELSE NOW() END,
       unsubscribed_at = NULL`,
    [info.chatId, info.username ?? null, info.firstName ?? null, info.lastName ?? null]
  );
}

export async function removeSubscriber(chatId: string): Promise<void> {
  await pool.query(
    `UPDATE subscribers SET active = FALSE, unsubscribed_at = NOW()
     WHERE chat_id = $1 AND active`,
    [chatId]
  );
}

export async function getActiveSubscriberIds(): Promise<string[]> {
  const result = await pool.query<{ chat_id: string }>(
    "SELECT chat_id FROM subscribers WHERE active"
  );
  return result.rows.map((row) => row.chat_id);
}

export async function countActiveSubscribers(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM subscribers WHERE active"
  );
  return parseInt(result.rows[0].count);
}

export async function listSubscribers(): Promise<Subscriber[]> {
  const result = await pool.query<{
    chat_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    active: boolean;
    subscribed_at: Date;
    unsubscribed_at: Date | null;
  }>(
    `SELECT chat_id, username, first_name, last_name, active, subscribed_at, unsubscribed_at
     FROM subscribers
     ORDER BY active DESC, subscribed_at DESC`
  );
  return result.rows.map((row) => ({
    chatId: row.chat_id,
    username: row.username ?? undefined,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    active: row.active,
    subscribedAt: row.subscribed_at.toISOString(),
    unsubscribedAt: row.unsubscribed_at?.toISOString() ?? null,
  }));
}
