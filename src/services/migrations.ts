import pg from "pg";
import { pool } from "./db.js";
import { log } from "../utils/logger.js";

// Numbered schema changes, applied once each in order and recorded in schema_migrations.
// Never edit an applied migration; add a new one instead.

interface Migration {
  id: number;
  name: string;
  up: (db: pg.PoolClient) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "accounts_and_subscriptions",
    up: async (db) => {
      await db.query(`
        -- One Telegram person; chat_id is where the bot sends their notifications
        CREATE TABLE users (
          id BIGSERIAL PRIMARY KEY,
          telegram_user_id BIGINT NOT NULL UNIQUE,
          chat_id BIGINT,
          username TEXT,
          first_name TEXT,
          last_name TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
          notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          bot_blocked BOOLEAN NOT NULL DEFAULT FALSE,
          trial_used BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );

        -- Billing and filter unit, shared by its members (e.g. a family)
        CREATE TABLE accounts (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          owner_user_id BIGINT REFERENCES users(id),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- A user belongs to at most one account for now (UNIQUE user_id)
        CREATE TABLE account_members (
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (account_id, user_id)
        );

        CREATE TABLE account_invites (
          id BIGSERIAL PRIMARY KEY,
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
          max_uses INT NOT NULL DEFAULT 1,
          uses INT NOT NULL DEFAULT 0,
          created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- One filter set per account; a NULL range end is unbounded
        CREATE TABLE account_filters (
          account_id BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          keywords TEXT[] NOT NULL DEFAULT '{}',
          rooms INT[] NOT NULL DEFAULT '{}',
          floor_min INT,
          floor_max INT,
          price_min NUMERIC,
          price_max NUMERIC,
          price_currency TEXT NOT NULL DEFAULT 'UAH',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE plans (
          id BIGSERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          price NUMERIC NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'UAH',
          duration_days INT NOT NULL,
          max_members INT NOT NULL,
          max_keywords INT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO plans (code, name, price, duration_days, max_members, max_keywords) VALUES
          ('trial', 'Пробний', 0, 3, 2, 10),
          ('family', 'Сімейний', 200, 30, 4, 30);

        -- Paid or trial periods; a new period starts where the previous one ends
        CREATE TABLE subscriptions (
          id BIGSERIAL PRIMARY KEY,
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          plan_id BIGINT NOT NULL REFERENCES plans(id),
          kind TEXT NOT NULL CHECK (kind IN ('trial', 'paid', 'gift')),
          source TEXT NOT NULL,
          starts_at TIMESTAMPTZ NOT NULL,
          ends_at TIMESTAMPTZ NOT NULL,
          cancelled_at TIMESTAMPTZ,
          created_by_admin_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX subscriptions_account ON subscriptions (account_id, ends_at);

        -- Ledger of money received, cash included
        CREATE TABLE payments (
          id BIGSERIAL PRIMARY KEY,
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
          paid_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          amount NUMERIC NOT NULL,
          currency TEXT NOT NULL,
          method TEXT NOT NULL,
          note TEXT,
          recorded_by_admin_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE admins (
          id BIGSERIAL PRIMARY KEY,
          login TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );

        -- Web sessions of both apps; only a hash of the cookie value is stored
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('user', 'admin')),
          subject_id BIGINT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- One-time login links sent by the bot (/login)
        CREATE TABLE login_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ
        );

        CREATE TABLE audit_log (
          id BIGSERIAL PRIMARY KEY,
          actor_type TEXT NOT NULL,
          actor_id BIGINT,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id BIGINT,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX audit_log_created ON audit_log (created_at DESC);

        -- Matched posts, stored once; deleted after POST_RETENTION_DAYS
        CREATE TABLE posts (
          id BIGSERIAL PRIMARY KEY,
          channel_id TEXT NOT NULL,
          message_id INT NOT NULL,
          channel_title TEXT NOT NULL,
          message_link TEXT NOT NULL,
          text TEXT NOT NULL,
          parsed JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (channel_id, message_id)
        );

        CREATE TABLE deliveries (
          post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (post_id, user_id)
        );
        CREATE INDEX deliveries_account ON deliveries (account_id, sent_at DESC);

        -- Bot notices already sent (expiry reminders), so each goes out once
        CREATE TABLE notices_sent (
          account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (account_id, key)
        );
      `);
    },
  },
  {
    id: 2,
    name: "import_single_tenant_data",
    // Before accounts existed every subscriber got every match with one global filter set:
    // that is one shared account, so it's imported as such and stays paid for
    up: async (db) => {
      const subscribers = await db.query<{
        chat_id: string;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
      }>(
        `SELECT chat_id, username, first_name, last_name FROM subscribers
         WHERE active ORDER BY subscribed_at`
      );
      if (subscribers.rows.length === 0) return;

      const userIds: string[] = [];
      for (const s of subscribers.rows) {
        // Bot chats are private, so the chat id is the Telegram user id
        const user = await db.query<{ id: string }>(
          `INSERT INTO users (telegram_user_id, chat_id, username, first_name, last_name, trial_used)
           VALUES ($1, $1, $2, $3, $4, TRUE) RETURNING id`,
          [s.chat_id, s.username, s.first_name, s.last_name]
        );
        userIds.push(user.rows[0].id);
      }

      const account = await db.query<{ id: string }>(
        "INSERT INTO accounts (name, owner_user_id) VALUES ('Основний акаунт', $1) RETURNING id",
        [userIds[0]]
      );
      const accountId = account.rows[0].id;
      for (const [index, userId] of userIds.entries()) {
        await db.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [
          accountId,
          userId,
          index === 0 ? "owner" : "editor",
        ]);
      }

      const keywords = await db.query<{ keyword: string }>("SELECT keyword FROM keywords ORDER BY added_at");
      const settings = new Map(
        (await db.query<{ key: string; value: any }>("SELECT key, value FROM settings")).rows.map((r) => [
          r.key,
          r.value,
        ])
      );
      const floor = settings.get("floor") ?? {};
      const price = settings.get("price") ?? {};
      await db.query(
        `INSERT INTO account_filters
           (account_id, keywords, rooms, floor_min, floor_max, price_min, price_max, price_currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          accountId,
          keywords.rows.map((r) => r.keyword),
          Array.isArray(settings.get("rooms")) ? settings.get("rooms") : [],
          floor.min ?? null,
          floor.max ?? null,
          price.min ?? null,
          price.max ?? null,
          price.currency ?? "UAH",
        ]
      );

      await db.query(
        `INSERT INTO subscriptions (account_id, plan_id, kind, source, starts_at, ends_at)
         SELECT $1, id, 'gift', 'migration', NOW(), NOW() + INTERVAL '10 years' FROM plans WHERE code = 'family'`,
        [accountId]
      );
      await db.query(
        `INSERT INTO audit_log (actor_type, action, target_type, target_id, payload)
         VALUES ('system', 'account.imported', 'account', $1, $2)`,
        [accountId, JSON.stringify({ members: userIds.length, keywords: keywords.rows.length })]
      );
      log("INFO", "Imported existing subscribers as one account", {
        accountId,
        members: userIds.length,
      });
    },
  },
  {
    id: 3,
    name: "admin_roles_and_2fa",
    up: async (db) => {
      await db.query(`
        -- Owners manage admins and the Telegram reader login; admins do everything else
        ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin'));
        -- A disabled admin can't sign in; the row stays for the audit log
        ALTER TABLE admins ADD COLUMN disabled_at TIMESTAMPTZ;
        -- TOTP secret (base32); set but not enabled while the admin is still setting up their app
        ALTER TABLE admins ADD COLUMN totp_secret TEXT;
        ALTER TABLE admins ADD COLUMN totp_enabled_at TIMESTAMPTZ;
        -- Last time step a code was accepted for, so a code can't be used twice
        ALTER TABLE admins ADD COLUMN totp_last_step BIGINT;
        -- The first admin, created from the env vars, becomes the owner
        UPDATE admins SET role = 'owner' WHERE id = (SELECT MIN(id) FROM admins);
      `);
    },
  },
];

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set(
    (await pool.query<{ id: number }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const db = await pool.connect();
    try {
      // The lock keeps two instances (e.g. during a redeploy) from migrating at once
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(724501)");
      const done = await db.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
      if (done.rows.length === 0) {
        await migration.up(db);
        await db.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
          migration.id,
          migration.name,
        ]);
        log("INFO", `Applied migration ${migration.id}: ${migration.name}`);
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
