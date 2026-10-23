import { pool, Db, withTransaction } from "./db.js";
import { TRIAL_DAYS } from "../config.js";
import { audit, Actor } from "./audit.js";
import { invalidateAudience } from "./audience.js";
import { log } from "../utils/logger.js";

// Plans and subscription periods. An account gets notifications while one of its periods
// covers the current moment. grantSubscription is the only way to add a period: cash
// payments recorded by an admin now, and payment provider webhooks later, all go through it.

export interface Plan {
  id: string;
  code: string;
  name: string;
  price: number;
  currency: string;
  durationDays: number;
  maxMembers: number;
  maxKeywords: number;
  active: boolean;
}

export const TRIAL_PLAN_CODE = "trial";

function toPlan(row: any): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    price: Number(row.price),
    currency: row.currency,
    durationDays: row.duration_days,
    maxMembers: row.max_members,
    maxKeywords: row.max_keywords,
    active: row.active,
  };
}

export async function listPlans(): Promise<Plan[]> {
  const result = await pool.query("SELECT * FROM plans ORDER BY price, id");
  return result.rows.map(toPlan);
}

export async function getPlan(id: string, db: Db = pool): Promise<Plan | null> {
  const result = await db.query("SELECT * FROM plans WHERE id = $1", [id]);
  return result.rows[0] ? toPlan(result.rows[0]) : null;
}

async function getPlanByCode(code: string, db: Db = pool): Promise<Plan | null> {
  const result = await db.query("SELECT * FROM plans WHERE code = $1", [code]);
  return result.rows[0] ? toPlan(result.rows[0]) : null;
}

export type PlanInput = Omit<Plan, "id">;

function validatePlan(input: Record<string, unknown>): PlanInput | string {
  const { code, name, price, currency, durationDays, maxMembers, maxKeywords, active } = input;
  const positiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  if (typeof code !== "string" || !/^[a-z0-9_-]{2,32}$/.test(code)) return "Код: 2–32 символи a-z, 0-9, _ або -";
  if (typeof name !== "string" || !name.trim()) return "Назва порожня";
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return "Некоректна ціна";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return "Некоректна валюта";
  if (!positiveInt(durationDays)) return "Тривалість має бути цілим числом днів";
  if (!positiveInt(maxMembers)) return "Ліміт учасників має бути цілим числом";
  if (!positiveInt(maxKeywords)) return "Ліміт ключових слів має бути цілим числом";
  return {
    code,
    name: name.trim(),
    price,
    currency,
    durationDays: durationDays as number,
    maxMembers: maxMembers as number,
    maxKeywords: maxKeywords as number,
    active: active !== false,
  };
}

// Creates the plan when id is null; returns an error message or null
export async function savePlan(id: string | null, input: Record<string, unknown>, actor: Actor): Promise<string | null> {
  const plan = validatePlan(input);
  if (typeof plan === "string") return plan;
  const values = [plan.code, plan.name, plan.price, plan.currency, plan.durationDays, plan.maxMembers, plan.maxKeywords, plan.active];
  try {
    const result = id
      ? await pool.query(
          `UPDATE plans SET code = $1, name = $2, price = $3, currency = $4, duration_days = $5,
             max_members = $6, max_keywords = $7, active = $8 WHERE id = $9 RETURNING id`,
          [...values, id]
        )
      : await pool.query(
          `INSERT INTO plans (code, name, price, currency, duration_days, max_members, max_keywords, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          values
        );
    if (result.rows.length === 0) return "Тариф не знайдено";
    await audit(actor, id ? "plan.updated" : "plan.created", { type: "plan", id: result.rows[0].id }, plan);
    return null;
  } catch (error: any) {
    if (error?.code === "23505") return "Тариф з таким кодом уже є";
    throw error;
  }
}

export interface SubscriptionStatus {
  active: boolean;
  kind: "trial" | "paid" | "gift" | null;
  plan: Plan | null;
  // End of the last period, active or not; null when the account never had one
  endsAt: string | null;
  daysLeft: number;
}

// One query: the current period with its plan (columns are null when there is none) and the end
// of the last period
export async function getSubscriptionStatus(accountId: string, db: Db = pool): Promise<SubscriptionStatus> {
  const result = await db.query(
    `SELECT cur.*,
       (SELECT MAX(ends_at) FROM subscriptions WHERE account_id = $1 AND cancelled_at IS NULL) AS last_ends_at
     FROM (SELECT 1) one
     LEFT JOIN LATERAL (
       SELECT s.kind, p.* FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.account_id = $1 AND s.cancelled_at IS NULL AND s.starts_at <= NOW() AND s.ends_at > NOW()
       ORDER BY s.starts_at DESC LIMIT 1
     ) cur ON TRUE`,
    [accountId]
  );
  const row = result.rows[0];
  const endsAt: Date | null = row.last_ends_at;
  const active = row.id !== null;
  return {
    active,
    kind: active ? row.kind : null,
    plan: active ? toPlan(row) : null,
    endsAt: endsAt?.toISOString() ?? null,
    daysLeft: active && endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000)) : 0,
  };
}

// Limits of the current plan; without an active subscription, those of the trial plan. Pass the
// status when it's already loaded, to save the query.
export async function getAccountLimits(
  accountId: string,
  db: Db = pool,
  known?: SubscriptionStatus
): Promise<{ maxMembers: number; maxKeywords: number }> {
  const status = known ?? (await getSubscriptionStatus(accountId, db));
  const plan = status.plan ?? (await getPlanByCode(TRIAL_PLAN_CODE, db));
  return { maxMembers: plan?.maxMembers ?? 1, maxKeywords: plan?.maxKeywords ?? 10 };
}

export interface GrantInput {
  accountId: string;
  planId: string;
  kind: "trial" | "paid" | "gift";
  // e.g. "manual", "trial", later "stars" or a payment provider
  source: string;
  days: number;
  payment?: { amount: number; currency: string; method: string; note?: string; paidByUserId?: string | null };
}

// The new period starts when the current one ends, so renewing early loses nothing
export async function grantSubscription(input: GrantInput, actor: Actor, db?: Db): Promise<string> {
  const run = async (tx: Db) => {
    const last = await tx.query<{ ends_at: Date | null }>(
      "SELECT MAX(ends_at) AS ends_at FROM subscriptions WHERE account_id = $1 AND cancelled_at IS NULL",
      [input.accountId]
    );
    const start = new Date(Math.max(Date.now(), last.rows[0].ends_at?.getTime() ?? 0));
    const end = new Date(start.getTime() + input.days * 86_400_000);
    const sub = await tx.query<{ id: string }>(
      `INSERT INTO subscriptions (account_id, plan_id, kind, source, starts_at, ends_at, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.accountId, input.planId, input.kind, input.source, start, end, actor.type === "admin" ? actor.id : null]
    );
    const subscriptionId = sub.rows[0].id;
    if (input.payment) {
      const p = input.payment;
      await tx.query(
        `INSERT INTO payments (account_id, subscription_id, paid_by_user_id, amount, currency, method, note, recorded_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.accountId, subscriptionId, p.paidByUserId ?? null, p.amount, p.currency, p.method, p.note ?? null,
          actor.type === "admin" ? actor.id : null]
      );
    }
    await audit(actor, "subscription.granted", { type: "account", id: input.accountId }, {
      subscriptionId,
      planId: input.planId,
      kind: input.kind,
      source: input.source,
      days: input.days,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      payment: input.payment ?? null,
    }, tx);
    return subscriptionId;
  };

  const id = db ? await run(db) : await withTransaction(run);
  invalidateAudience();
  return id;
}

export async function cancelSubscription(subscriptionId: string, actor: Actor): Promise<boolean> {
  const result = await pool.query(
    "UPDATE subscriptions SET cancelled_at = NOW() WHERE id = $1 AND cancelled_at IS NULL RETURNING account_id",
    [subscriptionId]
  );
  if (result.rows.length === 0) return false;
  await audit(actor, "subscription.cancelled", { type: "account", id: result.rows[0].account_id }, { subscriptionId });
  invalidateAudience();
  return true;
}

// Once per Telegram user, so recreating accounts doesn't give endless trials
export async function startTrialIfEligible(accountId: string, userId: string, db: Db): Promise<boolean> {
  if (TRIAL_DAYS <= 0) return false;
  const claimed = await db.query(
    "UPDATE users SET trial_used = TRUE WHERE id = $1 AND NOT trial_used RETURNING id",
    [userId]
  );
  if (claimed.rows.length === 0) return false;
  const plan = await getPlanByCode(TRIAL_PLAN_CODE, db);
  if (!plan) {
    log("WARN", "Trial plan is missing, no trial given", { code: TRIAL_PLAN_CODE });
    return false;
  }
  await grantSubscription(
    { accountId, planId: plan.id, kind: "trial", source: "trial", days: TRIAL_DAYS },
    { type: "user", id: userId },
    db
  );
  return true;
}

export interface SubscriptionRow {
  id: string;
  planName: string;
  kind: string;
  source: string;
  startsAt: string;
  endsAt: string;
  cancelledAt: string | null;
  adminLogin: string | null;
}

export async function listSubscriptions(accountId: string): Promise<SubscriptionRow[]> {
  const result = await pool.query(
    `SELECT s.*, p.name AS plan_name, a.login AS admin_login
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN admins a ON a.id = s.created_by_admin_id
     WHERE s.account_id = $1 ORDER BY s.starts_at DESC`,
    [accountId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    planName: row.plan_name,
    kind: row.kind,
    source: row.source,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    adminLogin: row.admin_login,
  }));
}

export interface PaymentRow {
  id: string;
  amount: number;
  currency: string;
  method: string;
  note: string | null;
  adminLogin: string | null;
  createdAt: string;
}

export async function listPayments(accountId: string): Promise<PaymentRow[]> {
  const result = await pool.query(
    `SELECT p.*, a.login AS admin_login FROM payments p LEFT JOIN admins a ON a.id = p.recorded_by_admin_id
     WHERE p.account_id = $1 ORDER BY p.created_at DESC`,
    [accountId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    note: row.note,
    adminLogin: row.admin_login,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface BusinessOverview {
  users: number;
  accounts: number;
  activePaid: number;
  activeTrials: number;
  expiringIn7Days: number;
  signups30d: number;
  // Accounts that ever had a trial, and how many of them later paid
  trialAccounts: number;
  convertedTrials: number;
  revenue30d: { currency: string; amount: number }[];
}

export async function getBusinessOverview(): Promise<BusinessOverview> {
  const counts = await pool.query(`
    WITH current AS (
      SELECT DISTINCT ON (account_id) account_id, kind FROM subscriptions
      WHERE cancelled_at IS NULL AND starts_at <= NOW() AND ends_at > NOW()
      ORDER BY account_id, starts_at DESC
    ), coverage AS (
      SELECT account_id, MAX(ends_at) AS ends_at FROM subscriptions WHERE cancelled_at IS NULL GROUP BY account_id
    )
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM accounts WHERE status <> 'archived') AS accounts,
      (SELECT COUNT(*) FROM current WHERE kind <> 'trial') AS active_paid,
      (SELECT COUNT(*) FROM current WHERE kind = 'trial') AS active_trials,
      (SELECT COUNT(*) FROM coverage WHERE ends_at > NOW() AND ends_at <= NOW() + INTERVAL '7 days') AS expiring,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days') AS signups,
      (SELECT COUNT(DISTINCT account_id) FROM subscriptions WHERE kind = 'trial') AS trial_accounts,
      (SELECT COUNT(DISTINCT t.account_id) FROM subscriptions t
         JOIN subscriptions p ON p.account_id = t.account_id AND p.kind = 'paid' AND p.cancelled_at IS NULL
         WHERE t.kind = 'trial') AS converted
  `);
  const revenue = await pool.query(
    `SELECT currency, SUM(amount) AS amount FROM payments
     WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY currency ORDER BY currency`
  );
  const c = counts.rows[0];
  return {
    users: Number(c.users),
    accounts: Number(c.accounts),
    activePaid: Number(c.active_paid),
    activeTrials: Number(c.active_trials),
    expiringIn7Days: Number(c.expiring),
    signups30d: Number(c.signups),
    trialAccounts: Number(c.trial_accounts),
    convertedTrials: Number(c.converted),
    revenue30d: revenue.rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) })),
  };
}
