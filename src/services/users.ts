import { pool, Db } from "./db.js";
import { invalidateAudience } from "./audience.js";

// A Telegram person. They sign in to the user app with Telegram and get notifications in
// their private chat with the bot.

export interface TelegramProfile {
  telegramUserId: string;
  // Known once the user has written to the bot; the login widget alone doesn't give it
  chatId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface User {
  id: string;
  telegramUserId: string;
  chatId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  status: "active" | "blocked";
  notificationsEnabled: boolean;
  botBlocked: boolean;
  trialUsed: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function toUser(row: any): User {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    notificationsEnabled: row.notifications_enabled,
    botBlocked: row.bot_blocked,
    trialUsed: row.trial_used,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

export function displayName(user: Pick<User, "username" | "firstName" | "lastName">): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return fullName || (user.username ? `@${user.username}` : "Без імені");
}

// Writing to the bot also proves the chat is open again, so bot_blocked is cleared
export async function upsertTelegramUser(profile: TelegramProfile, db: Db = pool): Promise<User> {
  const result = await db.query(
    `INSERT INTO users (telegram_user_id, chat_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       chat_id = COALESCE(EXCLUDED.chat_id, users.chat_id),
       username = COALESCE(EXCLUDED.username, users.username),
       first_name = COALESCE(EXCLUDED.first_name, users.first_name),
       last_name = COALESCE(EXCLUDED.last_name, users.last_name),
       bot_blocked = CASE WHEN EXCLUDED.chat_id IS NULL THEN users.bot_blocked ELSE FALSE END
     RETURNING *`,
    [
      profile.telegramUserId,
      profile.chatId ?? null,
      profile.username ?? null,
      profile.firstName ?? null,
      profile.lastName ?? null,
    ]
  );
  if (profile.chatId) invalidateAudience();
  return toUser(result.rows[0]);
}

export async function getUser(id: string, db: Db = pool): Promise<User | null> {
  const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function getUserByTelegramId(telegramUserId: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [telegramUserId]);
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function touchLogin(userId: string): Promise<void> {
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [userId]);
}

// The user blocked the bot or deleted their Telegram account
export async function markBotBlocked(chatId: string): Promise<void> {
  await pool.query("UPDATE users SET bot_blocked = TRUE WHERE chat_id = $1", [chatId]);
  invalidateAudience();
}

export async function setNotificationsEnabled(userId: string, enabled: boolean): Promise<void> {
  await pool.query("UPDATE users SET notifications_enabled = $2 WHERE id = $1", [userId, enabled]);
  invalidateAudience();
}

export async function setUserStatus(userId: string, status: User["status"]): Promise<void> {
  await pool.query("UPDATE users SET status = $2 WHERE id = $1", [userId, status]);
  invalidateAudience();
}

export interface UserListItem extends User {
  accountId: string | null;
  accountName: string | null;
  role: string | null;
}

// Searches by @username, name or Telegram id
export async function searchUsers(query: string, limit = 100): Promise<UserListItem[]> {
  const q = query.trim().replace(/^@/, "");
  const result = await pool.query(
    `SELECT u.*, m.account_id, m.role, a.name AS account_name
     FROM users u
     LEFT JOIN account_members m ON m.user_id = u.id
     LEFT JOIN accounts a ON a.id = m.account_id
     WHERE $1 = ''
        OR u.username ILIKE '%' || $1 || '%'
        OR (COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) ILIKE '%' || $1 || '%'
        OR u.telegram_user_id::text = $1
     ORDER BY u.created_at DESC
     LIMIT $2`,
    [q, limit]
  );
  return result.rows.map((row) => ({
    ...toUser(row),
    accountId: row.account_id,
    accountName: row.account_name,
    role: row.role,
  }));
}
