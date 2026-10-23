import { createHash, randomBytes } from "node:crypto";
import { pool, Db, withTransaction } from "./db.js";
import { audit, Actor } from "./audit.js";
import { invalidateAudience } from "./audience.js";
import { createFilters } from "./account-filters.js";
import { getAccountLimits, getSubscriptionStatus, startTrialIfEligible, SubscriptionStatus } from "./subscriptions.js";
import { User, displayName } from "./users.js";
import { log } from "../utils/logger.js";

// Accounts are shared by their members (e.g. a family looking for a flat together): one
// filter set, one subscription, notifications to everyone. A user is in one account at a
// time. These functions back both the web app and, later, bot commands, so permission
// checks live here rather than in the handlers.

export type Role = "owner" | "editor" | "viewer";

export interface Membership {
  accountId: string;
  accountName: string;
  accountStatus: "active" | "blocked" | "archived";
  role: Role;
  userId: string;
}

const INVITE_TTL_DAYS = 7;

export const can = {
  editFilters: (role: Role) => role === "owner" || role === "editor",
  invite: (role: Role) => role === "owner" || role === "editor",
  manageMembers: (role: Role) => role === "owner",
  rename: (role: Role) => role === "owner",
};

export async function getMembership(userId: string, db: Db = pool): Promise<Membership | null> {
  const result = await db.query(
    `SELECT m.account_id, m.role, a.name, a.status FROM account_members m
     JOIN accounts a ON a.id = m.account_id WHERE m.user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row
    ? { accountId: row.account_id, accountName: row.name, accountStatus: row.status, role: row.role, userId }
    : null;
}

async function createPersonalAccount(user: User, db: Db): Promise<string> {
  const name = user.firstName || (user.username ? `@${user.username}` : "Мій акаунт");
  const account = await db.query<{ id: string }>(
    "INSERT INTO accounts (name, owner_user_id) VALUES ($1, $2) RETURNING id",
    [name, user.id]
  );
  const accountId = account.rows[0].id;
  await db.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')", [accountId, user.id]);
  await createFilters(accountId, db);
  await audit({ type: "user", id: user.id }, "account.created", { type: "account", id: accountId }, undefined, db);
  return accountId;
}

// Every user has an account: created on first contact (bot /start or web login), and again
// after they leave or are removed from a shared one. The trial is given only once per user.
export async function ensureAccount(user: User): Promise<{ membership: Membership; created: boolean; trialStarted: boolean }> {
  const existing = await getMembership(user.id);
  if (existing) return { membership: existing, created: false, trialStarted: false };

  const trialStarted = await withTransaction(async (db) => {
    // Serializes concurrent first contacts of the same user (bot and web at once)
    await db.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [user.id]);
    if (await getMembership(user.id, db)) return false;
    const accountId = await createPersonalAccount(user, db);
    return startTrialIfEligible(accountId, user.id, db);
  });
  invalidateAudience();
  const membership = await getMembership(user.id);
  if (!membership) throw new Error("Account was not created");
  log("INFO", "Account created", { userId: user.id, accountId: membership.accountId, trialStarted });
  return { membership, created: true, trialStarted };
}

export async function renameAccount(m: Membership, name: string): Promise<string | null> {
  if (!can.rename(m.role)) return "Назву може змінити лише власник";
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) return "Назва має містити від 1 до 60 символів";
  await pool.query("UPDATE accounts SET name = $2 WHERE id = $1", [m.accountId, trimmed]);
  return null;
}

export interface Member {
  userId: string;
  name: string;
  username: string | null;
  role: Role;
  joinedAt: string;
  notificationsEnabled: boolean;
  botBlocked: boolean;
  chatId: string | null;
}

export async function listMembers(accountId: string, db: Db = pool): Promise<Member[]> {
  const result = await db.query(
    `SELECT u.*, m.role, m.joined_at FROM account_members m JOIN users u ON u.id = m.user_id
     WHERE m.account_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at`,
    [accountId]
  );
  return result.rows.map((row) => ({
    userId: row.id,
    name: displayName({ username: row.username, firstName: row.first_name, lastName: row.last_name }),
    username: row.username,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    notificationsEnabled: row.notifications_enabled,
    botBlocked: row.bot_blocked,
    chatId: row.chat_id,
  }));
}

// Only a hash of the token is stored, so the link can be shown once, when it's created
export interface Invite {
  id: string;
  role: Role;
  expiresAt: string;
  createdBy: string | null;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listInvites(accountId: string): Promise<Invite[]> {
  const result = await pool.query(
    `SELECT i.*, u.username, u.first_name, u.last_name FROM account_invites i
     LEFT JOIN users u ON u.id = i.created_by_user_id
     WHERE i.account_id = $1 AND i.revoked_at IS NULL AND i.expires_at > NOW() AND i.uses < i.max_uses
     ORDER BY i.created_at DESC`,
    [accountId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    createdBy: row.first_name || row.username
      ? displayName({ username: row.username, firstName: row.first_name, lastName: row.last_name })
      : null,
  }));
}

async function countMembers(accountId: string, db: Db): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM account_members WHERE account_id = $1",
    [accountId]
  );
  return Number(result.rows[0].count);
}

// Unused, unexpired invites an account may have at once
const MAX_ACTIVE_INVITES = 20;

// Single-use link, valid for a week; the token is returned this once
export async function createInvite(m: Membership, role: unknown): Promise<(Invite & { token: string }) | string> {
  if (!can.invite(m.role)) return "Запрошувати можуть лише власник і редактори";
  if (role !== "editor" && role !== "viewer") return "Невідома роль";
  const { maxMembers } = await getAccountLimits(m.accountId);
  if ((await countMembers(m.accountId, pool)) >= maxMembers) {
    return `Ваш тариф дозволяє до ${maxMembers} учасників`;
  }
  const active = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM account_invites
     WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > NOW() AND uses < max_uses`,
    [m.accountId]
  );
  if (Number(active.rows[0].count) >= MAX_ACTIVE_INVITES) {
    return `Забагато активних запрошень (${MAX_ACTIVE_INVITES}). Скасуйте непотрібні.`;
  }
  const token = randomBytes(12).toString("base64url");
  const result = await pool.query(
    `INSERT INTO account_invites (account_id, token_hash, role, created_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + $5 * INTERVAL '1 day') RETURNING id, expires_at`,
    [m.accountId, hashInviteToken(token), role, m.userId, INVITE_TTL_DAYS]
  );
  await audit({ type: "user", id: m.userId }, "invite.created", { type: "account", id: m.accountId }, { role });
  return { id: result.rows[0].id, token, role, expiresAt: result.rows[0].expires_at.toISOString(), createdBy: null };
}

export async function revokeInvite(m: Membership, inviteId: string): Promise<string | null> {
  if (!can.invite(m.role)) return "Недостатньо прав";
  await pool.query(
    "UPDATE account_invites SET revoked_at = NOW() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL",
    [inviteId, m.accountId]
  );
  return null;
}

interface InviteRow {
  id: string;
  account_id: string;
  role: Role;
  account_name: string;
  account_status: string;
  valid: boolean;
}

async function findInvite(token: string, db: Db, lock = false): Promise<InviteRow | null> {
  const result = await db.query<InviteRow>(
    `SELECT i.id, i.account_id, i.role, a.name AS account_name, a.status AS account_status,
       (i.revoked_at IS NULL AND i.expires_at > NOW() AND i.uses < i.max_uses) AS valid
     FROM account_invites i JOIN accounts a ON a.id = i.account_id
     WHERE i.token_hash = $1 ${lock ? "FOR UPDATE OF i" : ""}`,
    [hashInviteToken(token)]
  );
  return result.rows[0] ?? null;
}

// What joining would mean for this user; an error string when they can't join
async function checkJoin(invite: InviteRow | null, user: User, db: Db): Promise<{ current: Membership | null } | string> {
  if (!invite || !invite.valid) return "Запрошення недійсне або вже використане. Попросіть нове посилання.";
  if (invite.account_status !== "active") return "Цей акаунт зараз недоступний.";
  const current = await getMembership(user.id, db);
  if (current?.accountId === invite.account_id) return `Ви вже в акаунті «${invite.account_name}».`;
  if (current?.role === "owner" && (await countMembers(current.accountId, db)) > 1) {
    return `Ви власник акаунта «${current.accountName}», у якому є інші учасники. Спершу видаліть їх, щоб приєднатися до іншого акаунта.`;
  }
  const { maxMembers } = await getAccountLimits(invite.account_id, db);
  if ((await countMembers(invite.account_id, db)) >= maxMembers) {
    return `В акаунті «${invite.account_name}» уже максимальна кількість учасників (${maxMembers}).`;
  }
  return { current };
}

export interface InvitePreview {
  accountName: string;
  role: Role;
  // Set when joining moves the user out of their current account
  leavingAccountName: string | null;
}

export async function previewInvite(token: string, user: User): Promise<InvitePreview | string> {
  const invite = await findInvite(token, pool);
  const check = await checkJoin(invite, user, pool);
  if (typeof check === "string") return check;
  return { accountName: invite!.account_name, role: invite!.role, leavingAccountName: check.current?.accountName ?? null };
}

// A user's own solo account is archived when they join another one, keeping its history
export async function acceptInvite(token: string, user: User): Promise<{ accountId: string; accountName: string } | string> {
  const result = await withTransaction(async (db) => {
    const invite = await findInvite(token, db, true);
    // Locking the target account serializes joins, so the member limit holds
    if (invite) await db.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [invite.account_id]);
    const check = await checkJoin(invite, user, db);
    if (typeof check === "string") return check;
    const { current } = check;

    if (current) {
      await db.query("DELETE FROM account_members WHERE user_id = $1", [user.id]);
      if (current.role === "owner") {
        await db.query("UPDATE accounts SET status = 'archived' WHERE id = $1", [current.accountId]);
      }
    }
    await db.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [
      invite!.account_id,
      user.id,
      invite!.role,
    ]);
    await db.query("UPDATE account_invites SET uses = uses + 1 WHERE id = $1", [invite!.id]);
    await audit({ type: "user", id: user.id }, "member.joined", { type: "account", id: invite!.account_id }, {
      role: invite!.role,
      inviteId: invite!.id,
      leftAccountId: current?.accountId ?? null,
    }, db);
    return { accountId: invite!.account_id, accountName: invite!.account_name };
  });
  invalidateAudience();
  return result;
}

// Returns the removed member's chat, so the caller can tell them
export async function removeMember(m: Membership, userId: string): Promise<{ chatId: string | null } | string> {
  if (!can.manageMembers(m.role)) return "Видаляти учасників може лише власник";
  if (userId === m.userId) return "Власник не може видалити себе";
  const result = await pool.query<{ chat_id: string | null }>(
    `DELETE FROM account_members m USING users u
     WHERE m.account_id = $1 AND m.user_id = $2 AND u.id = m.user_id AND m.role <> 'owner'
     RETURNING u.chat_id`,
    [m.accountId, userId]
  );
  if (result.rows.length === 0) return "Учасника не знайдено";
  await audit({ type: "user", id: m.userId }, "member.removed", { type: "account", id: m.accountId }, { userId });
  invalidateAudience();
  return { chatId: result.rows[0].chat_id };
}

export async function setMemberRole(m: Membership, userId: string, role: unknown): Promise<string | null> {
  if (!can.manageMembers(m.role)) return "Змінювати ролі може лише власник";
  if (role !== "editor" && role !== "viewer") return "Невідома роль";
  const result = await pool.query(
    "UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2 AND role <> 'owner'",
    [m.accountId, userId, role]
  );
  if (result.rowCount === 0) return "Учасника не знайдено";
  await audit({ type: "user", id: m.userId }, "member.role_changed", { type: "account", id: m.accountId }, { userId, role });
  return null;
}

export async function leaveAccount(m: Membership): Promise<string | null> {
  if (m.role === "owner") return "Власник не може покинути акаунт. Зверніться до підтримки, щоб передати його.";
  await pool.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
  await audit({ type: "user", id: m.userId }, "member.left", { type: "account", id: m.accountId });
  invalidateAudience();
  return null;
}

// --- Admin operations ---

export interface AccountListItem {
  id: string;
  name: string;
  status: string;
  ownerName: string | null;
  ownerUsername: string | null;
  members: number;
  activeUntil: string | null;
  activeKind: string | null;
  lastEndsAt: string | null;
  createdAt: string;
}

export async function listAccounts(query: string, limit = 200): Promise<AccountListItem[]> {
  const q = query.trim().replace(/^@/, "");
  const result = await pool.query(
    `SELECT a.*, o.username AS owner_username, o.first_name, o.last_name,
       (SELECT COUNT(*) FROM account_members m WHERE m.account_id = a.id) AS members,
       (SELECT MAX(ends_at) FROM subscriptions s WHERE s.account_id = a.id AND s.cancelled_at IS NULL) AS last_ends_at,
       (SELECT kind FROM subscriptions s WHERE s.account_id = a.id AND s.cancelled_at IS NULL
          AND s.starts_at <= NOW() AND s.ends_at > NOW() ORDER BY s.starts_at DESC LIMIT 1) AS active_kind
     FROM accounts a LEFT JOIN users o ON o.id = a.owner_user_id
     WHERE $1 = '' OR a.name ILIKE '%' || $1 || '%' OR a.id::text = $1
        OR EXISTS (SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id
                   WHERE m.account_id = a.id AND (u.username ILIKE '%' || $1 || '%' OR u.telegram_user_id::text = $1
                     OR (COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) ILIKE '%' || $1 || '%'))
     ORDER BY a.status = 'archived', a.created_at DESC
     LIMIT $2`,
    [q, limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    ownerName: row.first_name || row.owner_username
      ? displayName({ username: row.owner_username, firstName: row.first_name, lastName: row.last_name })
      : null,
    ownerUsername: row.owner_username,
    members: Number(row.members),
    activeUntil: row.active_kind ? row.last_ends_at?.toISOString() ?? null : null,
    activeKind: row.active_kind,
    lastEndsAt: row.last_ends_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface AccountDetail {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  subscription: SubscriptionStatus;
  limits: { maxMembers: number; maxKeywords: number };
  members: Member[];
  deliveries30d: number;
}

export async function getAccountDetail(accountId: string): Promise<AccountDetail | null> {
  const result = await pool.query("SELECT * FROM accounts WHERE id = $1", [accountId]);
  const row = result.rows[0];
  if (!row) return null;
  const [deliveries, subscription, members] = await Promise.all([
    pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM deliveries WHERE account_id = $1 AND sent_at > NOW() - INTERVAL '30 days'",
      [accountId]
    ),
    getSubscriptionStatus(accountId),
    listMembers(accountId),
  ]);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    subscription,
    limits: await getAccountLimits(accountId, pool, subscription),
    members,
    deliveries30d: Number(deliveries.rows[0].count),
  };
}

export async function setAccountStatus(accountId: string, status: unknown, actor: Actor): Promise<string | null> {
  if (status !== "active" && status !== "blocked") return "Невідомий статус";
  const result = await pool.query("UPDATE accounts SET status = $2 WHERE id = $1", [accountId, status]);
  if (result.rowCount === 0) return "Акаунт не знайдено";
  await audit(actor, status === "blocked" ? "account.blocked" : "account.unblocked", { type: "account", id: accountId });
  invalidateAudience();
  return null;
}

export async function transferOwnership(accountId: string, userId: string, actor: Actor): Promise<string | null> {
  return withTransaction(async (db) => {
    const target = await db.query(
      "SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2",
      [accountId, userId]
    );
    if (target.rows.length === 0) return "Користувач не є учасником цього акаунта";
    await db.query("UPDATE account_members SET role = 'editor' WHERE account_id = $1 AND role = 'owner'", [accountId]);
    await db.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
    await db.query("UPDATE accounts SET owner_user_id = $2 WHERE id = $1", [accountId, userId]);
    await audit(actor, "account.ownership_transferred", { type: "account", id: accountId }, { userId }, db);
    return null;
  });
}

// Moves a user into an account, out of the one they're in; their old account is archived
// if they were its only member. An owner with other members must be replaced first.
export async function moveUserToAccount(accountId: string, userId: string, role: unknown, actor: Actor): Promise<string | null> {
  if (role !== "editor" && role !== "viewer") return "Невідома роль";
  const error = await withTransaction(async (db) => {
    const account = await db.query("SELECT status FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
    if (account.rows.length === 0) return "Акаунт не знайдено";
    const current = await getMembership(userId, db);
    if (current?.accountId === accountId) return "Користувач уже в цьому акаунті";
    if (current) {
      const members = await countMembers(current.accountId, db);
      if (current.role === "owner" && members > 1) return "Користувач — власник іншого акаунта з учасниками; спершу передайте власність";
      await db.query("DELETE FROM account_members WHERE user_id = $1", [userId]);
      if (current.role === "owner") await db.query("UPDATE accounts SET status = 'archived' WHERE id = $1", [current.accountId]);
    }
    await db.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    await audit(actor, "member.moved", { type: "account", id: accountId }, { userId, role, fromAccountId: current?.accountId ?? null }, db);
    return null;
  });
  invalidateAudience();
  return error;
}

export async function adminRemoveMember(accountId: string, userId: string, actor: Actor): Promise<string | null> {
  const result = await pool.query(
    "DELETE FROM account_members WHERE account_id = $1 AND user_id = $2 AND role <> 'owner'",
    [accountId, userId]
  );
  if (result.rowCount === 0) return "Учасника не знайдено (власника видалити не можна)";
  await audit(actor, "member.removed", { type: "account", id: accountId }, { userId });
  invalidateAudience();
  return null;
}
