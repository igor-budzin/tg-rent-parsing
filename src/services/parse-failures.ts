import { pool } from "./db.js";
import { log } from "../utils/logger.js";

// Older rows are deleted so the log doesn't grow without bound
const MAX_STORED_FAILURES = 1000;

export type ParseFailureReason =
  | "api_error" // OpenRouter answered with an HTTP error
  | "network" // timeout or connection failure
  | "empty_response" // the model answered without content
  | "invalid_json" // the content wasn't JSON
  | "nothing_extracted" // valid JSON, but no listing fields
  | "cooldown" // skipped: AI paused after rate limits or outages
  | "no_models" // skipped: none of the configured models exist on OpenRouter
  | "backlog" // skipped: too many posts waiting for the AI, sent unparsed to keep delivery fast
  | "error"; // anything else

// The post the model was asked to parse
export interface PostSource {
  channel?: string;
  messageLink?: string;
  // 0 for the live attempt, 1+ for retries from the parse queue
  attempt?: number;
  // A failed parse puts the post in the retry queue instead of sending it raw
  queueOnFailure?: boolean;
}

export interface ParseFailureInput {
  reason: ParseFailureReason;
  // Fallback chain sent in the request
  models: string[];
  // Model that answered, when there was an answer
  model?: string | null;
  status?: number | null;
  error?: string | null;
  // Raw model output
  response?: string | null;
  details?: Record<string, unknown> | null;
  // The post goes to the next model instead of being sent raw
  willRetry?: boolean;
  durationMs?: number | null;
  postText: string;
  source?: PostSource;
}

export interface ParseFailure extends Omit<ParseFailureInput, "source"> {
  id: string;
  createdAt: string;
  channel: string | null;
  messageLink: string | null;
  attempt: number;
  // The post went to the retry queue
  queued: boolean;
}

export async function initParseFailuresTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parse_failures (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT NOT NULL,
      models TEXT[] NOT NULL DEFAULT '{}',
      model TEXT,
      status INT,
      error TEXT,
      response TEXT,
      details JSONB,
      will_retry BOOLEAN NOT NULL DEFAULT FALSE,
      duration_ms INT,
      channel TEXT,
      message_link TEXT,
      post_text TEXT NOT NULL
    )
  `);
  await pool.query("ALTER TABLE parse_failures ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE parse_failures ADD COLUMN IF NOT EXISTS queued BOOLEAN NOT NULL DEFAULT FALSE");
}

async function insertParseFailure(failure: ParseFailureInput): Promise<void> {
  await pool.query(
    `INSERT INTO parse_failures
       (reason, models, model, status, error, response, details, will_retry, duration_ms,
        channel, message_link, post_text, attempt, queued)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      failure.reason,
      failure.models,
      failure.model ?? null,
      failure.status ?? null,
      failure.error ?? null,
      failure.response ?? null,
      failure.details ? JSON.stringify(failure.details) : null,
      failure.willRetry ?? false,
      failure.durationMs != null ? Math.round(failure.durationMs) : null,
      failure.source?.channel ?? null,
      failure.source?.messageLink ?? null,
      failure.postText,
      failure.source?.attempt ?? 0,
      !failure.willRetry && (failure.source?.queueOnFailure ?? false),
    ]
  );
  await pool.query(
    `DELETE FROM parse_failures
     WHERE id < (SELECT id FROM parse_failures ORDER BY id DESC OFFSET $1 LIMIT 1)`,
    [MAX_STORED_FAILURES - 1]
  );
}

// Fire and forget: a database problem must not break post handling
export function recordParseFailure(failure: ParseFailureInput): void {
  insertParseFailure(failure).catch((error) => {
    log("WARN", "Could not save AI parse failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function listParseFailures(): Promise<ParseFailure[]> {
  const result = await pool.query<{
    id: string;
    created_at: Date;
    reason: ParseFailureReason;
    models: string[];
    model: string | null;
    status: number | null;
    error: string | null;
    response: string | null;
    details: Record<string, unknown> | null;
    will_retry: boolean;
    duration_ms: number | null;
    channel: string | null;
    message_link: string | null;
    post_text: string;
    attempt: number;
    queued: boolean;
  }>("SELECT * FROM parse_failures ORDER BY id DESC");
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    reason: row.reason,
    models: row.models,
    model: row.model,
    status: row.status,
    error: row.error,
    response: row.response,
    details: row.details,
    willRetry: row.will_retry,
    durationMs: row.duration_ms,
    channel: row.channel,
    messageLink: row.message_link,
    postText: row.post_text,
    attempt: row.attempt,
    queued: row.queued,
  }));
}

export async function clearParseFailures(): Promise<void> {
  await pool.query("TRUNCATE parse_failures");
}
