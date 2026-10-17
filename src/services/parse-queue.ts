import { pool } from "./db.js";

// Matched posts the AI failed to parse, waiting for another try. Kept in the database so
// pending retries survive a restart; the post itself is re-fetched from Telegram on retry.

export interface QueuedPost {
  id: string;
  channelId: string;
  messageId: number;
  channelTitle: string;
  messageLink: string;
  keywords: string[];
  // Retries already made (the first, live attempt isn't counted)
  attempts: number;
  createdAt: Date;
}

export async function initParseQueueTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parse_queue (
      id BIGSERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id INT NOT NULL,
      channel_title TEXT NOT NULL,
      message_link TEXT NOT NULL,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (channel_id, message_id)
    )
  `);
}

export async function enqueuePost(
  post: Omit<QueuedPost, "id" | "attempts" | "createdAt">,
  delayMs: number
): Promise<void> {
  await pool.query(
    `INSERT INTO parse_queue (channel_id, message_id, channel_title, message_link, keywords, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + $6 * INTERVAL '1 millisecond')
     ON CONFLICT (channel_id, message_id) DO NOTHING`,
    [post.channelId, post.messageId, post.channelTitle, post.messageLink, post.keywords, delayMs]
  );
}

export async function getDuePosts(limit: number): Promise<QueuedPost[]> {
  const result = await pool.query<{
    id: string;
    channel_id: string;
    message_id: number;
    channel_title: string;
    message_link: string;
    keywords: string[];
    attempts: number;
    created_at: Date;
  }>(
    "SELECT * FROM parse_queue WHERE next_attempt_at <= NOW() ORDER BY next_attempt_at, id LIMIT $1",
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    messageId: row.message_id,
    channelTitle: row.channel_title,
    messageLink: row.message_link,
    keywords: row.keywords,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

export async function reschedulePost(id: string, attempts: number, delayMs: number): Promise<void> {
  await pool.query(
    `UPDATE parse_queue
     SET attempts = $2, next_attempt_at = NOW() + $3 * INTERVAL '1 millisecond'
     WHERE id = $1`,
    [id, attempts, delayMs]
  );
}

export async function removeQueuedPost(id: string): Promise<void> {
  await pool.query("DELETE FROM parse_queue WHERE id = $1", [id]);
}
