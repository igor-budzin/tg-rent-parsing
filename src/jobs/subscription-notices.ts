import { pool } from "../services/db.js";
import { log } from "../utils/logger.js";
import { escapeHtml, sendBotText } from "../services/bot-api.js";
import { paymentHint } from "../services/bot-updates.js";
import { deleteOldPosts } from "../services/posts.js";
import { deleteExpiredAuthRows } from "../services/auth.js";

// Hourly: reminds owners before their subscription ends, tells all members once it has
// ended, and deletes data past its retention. Each notice is recorded in notices_sent, so
// restarts and overlapping runs don't send it twice.

const JOB_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
// Accounts that expired longer ago than this don't get the "expired" notice (e.g. on first deploy)
const EXPIRED_NOTICE_WINDOW_MS = 2 * DAY_MS;

interface Coverage {
  account_id: string;
  account_name: string;
  ends_at: Date;
  kind: string;
}

type Notice = { key: string; audience: "owner" | "members"; text: string };

function noticeFor(row: Coverage, now: number): Notice | null {
  const left = row.ends_at.getTime() - now;
  const end = row.ends_at.toISOString();
  const what = row.kind === "trial" ? "Пробний період" : "Підписка";
  const name = escapeHtml(row.account_name);
  const hint = paymentHint() ? `\n\n${paymentHint()}` : "";
  if (left > 0 && left <= DAY_MS) {
    return { key: `expiring1:${end}`, audience: "owner", text: `${what} акаунта «${name}» закінчується менш ніж за добу.${hint}` };
  }
  if (left > DAY_MS && left <= 3 * DAY_MS) {
    return { key: `expiring3:${end}`, audience: "owner", text: `${what} акаунта «${name}» закінчується через ${Math.ceil(left / DAY_MS)} дні.${hint}` };
  }
  if (left <= 0 && -left <= EXPIRED_NOTICE_WINDOW_MS) {
    return {
      key: `expired:${end}`,
      audience: "members",
      text: `${what} акаунта «${name}» закінчився — сповіщення про нові оголошення більше не надходять.${hint}`,
    };
  }
  return null;
}

async function sendNotices(): Promise<void> {
  // End of each account's last period and the kind of that period
  const result = await pool.query<Coverage>(`
    SELECT DISTINCT ON (s.account_id) s.account_id, a.name AS account_name, s.ends_at, s.kind
    FROM subscriptions s JOIN accounts a ON a.id = s.account_id
    WHERE s.cancelled_at IS NULL AND a.status = 'active'
    ORDER BY s.account_id, s.ends_at DESC
  `);
  const now = Date.now();

  for (const row of result.rows) {
    const notice = noticeFor(row, now);
    if (!notice) continue;
    const claimed = await pool.query(
      "INSERT INTO notices_sent (account_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1",
      [row.account_id, notice.key]
    );
    if (claimed.rows.length === 0) continue;

    const recipients = await pool.query<{ chat_id: string }>(
      `SELECT u.chat_id FROM account_members m JOIN users u ON u.id = m.user_id
       WHERE m.account_id = $1 AND u.chat_id IS NOT NULL AND NOT u.bot_blocked AND ($2 OR m.role = 'owner')`,
      [row.account_id, notice.audience === "members"]
    );
    for (const { chat_id } of recipients.rows) {
      await sendBotText(chat_id, notice.text);
    }
    log("INFO", "Subscription notice sent", { accountId: row.account_id, notice: notice.key, recipients: recipients.rows.length });
  }
}

export async function runSubscriptionJobsOnce(): Promise<void> {
  try {
    await sendNotices();
  } catch (error) {
    log("WARN", "Subscription notices failed", { error: String(error) });
  }
  try {
    const deleted = await deleteOldPosts();
    if (deleted > 0) log("INFO", "Deleted old posts", { deleted });
    await deleteExpiredAuthRows();
  } catch (error) {
    log("WARN", "Cleanup failed", { error: String(error) });
  }
}

export function startSubscriptionJobs(): void {
  void runSubscriptionJobsOnce();
  setInterval(runSubscriptionJobsOnce, JOB_INTERVAL_MS);
  log("INFO", "Subscription reminders and cleanup scheduled hourly");
}
