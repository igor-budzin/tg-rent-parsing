import { pool, Db } from "./db.js";
import { log } from "../utils/logger.js";

// Who did what to accounts, users and subscriptions; shown in the admin app

export interface Actor {
  type: "admin" | "user" | "system";
  id?: string | null;
}

export const SYSTEM: Actor = { type: "system" };

export interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export async function audit(
  actor: Actor,
  action: string,
  target: { type: string; id: string } | null,
  payload?: Record<string, unknown>,
  db: Db = pool
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.type, actor.id ?? null, action, target?.type ?? null, target?.id ?? null, payload ? JSON.stringify(payload) : null]
    );
  } catch (error) {
    // Inside a transaction the error must reach the caller, which rolls back
    if (db !== pool) throw error;
    log("WARN", "Could not write audit log", { action, error: String(error) });
  }
}

export async function listAudit(limit = 200, targetType?: string, targetId?: string): Promise<AuditEntry[]> {
  const result = await pool.query(
    `SELECT l.*,
       CASE l.actor_type
         WHEN 'admin' THEN (SELECT login FROM admins WHERE id = l.actor_id)
         WHEN 'user' THEN (SELECT COALESCE('@' || username, first_name) FROM users WHERE id = l.actor_id)
       END AS actor_name
     FROM audit_log l
     WHERE ($2::text IS NULL OR (l.target_type = $2 AND l.target_id = $3::bigint))
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $1`,
    [limit, targetType ?? null, targetId ?? null]
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }));
}
