import { pool } from "./db.js";

export interface SubscriberInfo {
  chatId: string;
  username?: string;
  firstName?: string;
}

export async function addSubscriber(info: SubscriberInfo): Promise<void> {
  await pool.query(
    `INSERT INTO subscribers (chat_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, subscribers.username),
       first_name = COALESCE(EXCLUDED.first_name, subscribers.first_name),
       active = TRUE,
       subscribed_at = CASE WHEN subscribers.active THEN subscribers.subscribed_at ELSE NOW() END,
       unsubscribed_at = NULL`,
    [info.chatId, info.username ?? null, info.firstName ?? null]
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
