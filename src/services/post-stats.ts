import { pool } from "./db.js";
import { log } from "../utils/logger.js";

// Days are counted in Kyiv time, so "today" matches the channels' audience
const STATS_TIME_ZONE = "Europe/Kyiv";
// Days of per-channel rows returned to the stats page
const STATS_HISTORY_DAYS = 90;

export type PostStatField =
  | "checked" // text post from a watched channel
  | "matched" // contains a keyword
  | "filtered_out" // parsed, but outside the room/floor/price filter
  | "sent"; // delivered to at least one subscriber

export interface PostStatsRow {
  day: string;
  channel: string;
  checked: number;
  matched: number;
  filteredOut: number;
  sent: number;
}

export interface PostStatsView {
  timeZone: string;
  today: string;
  rows: PostStatsRow[];
  allTime: Omit<PostStatsRow, "day" | "channel">;
}

export async function initPostStatsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_stats (
      day DATE NOT NULL,
      channel TEXT NOT NULL,
      checked INT NOT NULL DEFAULT 0,
      matched INT NOT NULL DEFAULT 0,
      filtered_out INT NOT NULL DEFAULT 0,
      sent INT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, channel)
    )
  `);
}

async function incrementPostStat(channel: string, field: PostStatField): Promise<void> {
  await pool.query(
    `INSERT INTO post_stats (day, channel, ${field})
     VALUES ((NOW() AT TIME ZONE $1)::date, $2, 1)
     ON CONFLICT (day, channel) DO UPDATE SET ${field} = post_stats.${field} + 1`,
    [STATS_TIME_ZONE, channel]
  );
}

// Fire and forget: a database problem must not break post handling
export function recordPostStat(channel: string, field: PostStatField): void {
  incrementPostStat(channel, field).catch((error) => {
    log("WARN", "Could not save post stats", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function getPostStats(): Promise<PostStatsView> {
  const today = await pool.query<{ today: string }>(
    "SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today",
    [STATS_TIME_ZONE]
  );
  const rows = await pool.query<{
    day: string;
    channel: string;
    checked: number;
    matched: number;
    filtered_out: number;
    sent: number;
  }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, channel, checked, matched, filtered_out, sent
     FROM post_stats
     WHERE day > (NOW() AT TIME ZONE $1)::date - $2::int
     ORDER BY day DESC, channel`,
    [STATS_TIME_ZONE, STATS_HISTORY_DAYS]
  );
  const allTime = await pool.query<{
    checked: string;
    matched: string;
    filtered_out: string;
    sent: string;
  }>(
    `SELECT COALESCE(SUM(checked), 0) AS checked, COALESCE(SUM(matched), 0) AS matched,
            COALESCE(SUM(filtered_out), 0) AS filtered_out, COALESCE(SUM(sent), 0) AS sent
     FROM post_stats`
  );
  const totals = allTime.rows[0];

  return {
    timeZone: STATS_TIME_ZONE,
    today: today.rows[0].today,
    rows: rows.rows.map((row) => ({
      day: row.day,
      channel: row.channel,
      checked: row.checked,
      matched: row.matched,
      filteredOut: row.filtered_out,
      sent: row.sent,
    })),
    allTime: {
      checked: Number(totals.checked),
      matched: Number(totals.matched),
      filteredOut: Number(totals.filtered_out),
      sent: Number(totals.sent),
    },
  };
}

export async function clearPostStats(): Promise<void> {
  await pool.query("TRUNCATE post_stats");
}
