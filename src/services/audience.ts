import { pool } from "./db.js";
import { Filters, toFilters } from "./filters.js";
import { log } from "../utils/logger.js";

// Who gets notifications right now: active accounts with a current subscription and their
// members who can be reached. Cached, since it's needed for every channel post; any change
// to accounts, members, filters or subscriptions invalidates it, and the TTL catches
// subscriptions that just ran out.

const CACHE_TTL_MS = 60_000;

export interface AudienceAccount {
  accountId: string;
  filters: Filters;
  recipients: { userId: string; chatId: string }[];
}

let cache: { accounts: AudienceAccount[]; loadedAt: number } | null = null;
let loading: Promise<AudienceAccount[]> | null = null;
// Bumped on every invalidation, so a load that started before a change isn't cached
let generation = 0;

export function invalidateAudience(): void {
  cache = null;
  generation++;
}

async function load(): Promise<AudienceAccount[]> {
  const result = await pool.query(`
    SELECT f.*, a.id AS account_id, u.id AS user_id, u.chat_id
    FROM accounts a
    JOIN account_filters f ON f.account_id = a.id
    JOIN account_members m ON m.account_id = a.id
    JOIN users u ON u.id = m.user_id
    WHERE a.status = 'active'
      AND u.status = 'active' AND u.notifications_enabled AND NOT u.bot_blocked AND u.chat_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.account_id = a.id AND s.cancelled_at IS NULL AND s.starts_at <= NOW() AND s.ends_at > NOW()
      )
    ORDER BY a.id, m.joined_at
  `);

  const byAccount = new Map<string, AudienceAccount>();
  for (const row of result.rows) {
    let account = byAccount.get(row.account_id);
    if (!account) {
      account = { accountId: row.account_id, filters: toFilters(row), recipients: [] };
      byAccount.set(row.account_id, account);
    }
    account.recipients.push({ userId: row.user_id, chatId: row.chat_id });
  }
  return [...byAccount.values()];
}

export async function getAudience(): Promise<AudienceAccount[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.accounts;
  if (!loading) {
    const startedAt = generation;
    loading = load()
      .then((accounts) => {
        if (startedAt === generation) cache = { accounts, loadedAt: Date.now() };
        return accounts;
      })
      .catch((error) => {
        log("WARN", "Could not load notification audience", { error: String(error) });
        // Keep serving the last known audience over a brief database outage
        if (cache) return cache.accounts;
        throw error;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

// Union of all audience keywords: a post is worth parsing if any account wants it
export async function getAllKeywords(): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const account of await getAudience()) {
    for (const keyword of account.filters.keywords) seen.set(keyword.toLowerCase(), keyword);
  }
  return [...seen.values()];
}

export async function countRecipients(): Promise<number> {
  return (await getAudience()).reduce((sum, a) => sum + a.recipients.length, 0);
}
