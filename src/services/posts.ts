import { pool } from "./db.js";
import { POST_RETENTION_DAYS } from "../config.js";
import { ParsedPost } from "../types/index.js";

// Matched posts and who they were sent to. A post is stored once however many accounts
// get it; deliveries make retries and reposts idempotent per user and feed "recent matches".

export interface PostRecord {
  channelId: string;
  messageId: number;
  channelTitle: string;
  messageLink: string;
  text: string;
  parsed: ParsedPost | null;
}

export async function savePost(post: PostRecord): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO posts (channel_id, message_id, channel_title, message_link, text, parsed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id, message_id) DO UPDATE SET parsed = COALESCE(EXCLUDED.parsed, posts.parsed)
     RETURNING id`,
    [post.channelId, post.messageId, post.channelTitle, post.messageLink, post.text, post.parsed ? JSON.stringify(post.parsed) : null]
  );
  return result.rows[0].id;
}

export async function getDeliveredUserIds(postId: string): Promise<Set<string>> {
  const result = await pool.query<{ user_id: string }>("SELECT user_id FROM deliveries WHERE post_id = $1", [postId]);
  return new Set(result.rows.map((r) => r.user_id));
}

export async function recordDeliveries(postId: string, delivered: { userId: string; accountId: string }[]): Promise<void> {
  if (delivered.length === 0) return;
  await pool.query(
    `INSERT INTO deliveries (post_id, user_id, account_id)
     SELECT $1, * FROM UNNEST($2::bigint[], $3::bigint[])
     ON CONFLICT DO NOTHING`,
    [postId, delivered.map((d) => d.userId), delivered.map((d) => d.accountId)]
  );
}

export interface RecentMatch {
  channelTitle: string;
  messageLink: string;
  preview: string;
  parsed: ParsedPost | null;
  sentAt: string;
}

export async function listRecentMatches(accountId: string, limit = 50): Promise<RecentMatch[]> {
  const result = await pool.query(
    `SELECT p.channel_title, p.message_link, LEFT(p.text, 300) AS preview, p.parsed, MAX(d.sent_at) AS sent_at
     FROM deliveries d JOIN posts p ON p.id = d.post_id
     WHERE d.account_id = $1
     GROUP BY p.id ORDER BY MAX(d.sent_at) DESC LIMIT $2`,
    [accountId, limit]
  );
  return result.rows.map((row) => ({
    channelTitle: row.channel_title,
    messageLink: row.message_link,
    preview: row.preview,
    parsed: row.parsed,
    sentAt: row.sent_at.toISOString(),
  }));
}

// Posts carry phone numbers and names, so they aren't kept longer than needed
export async function deleteOldPosts(): Promise<number> {
  const result = await pool.query("DELETE FROM posts WHERE created_at < NOW() - $1 * INTERVAL '1 day'", [
    POST_RETENTION_DAYS,
  ]);
  return result.rowCount ?? 0;
}
