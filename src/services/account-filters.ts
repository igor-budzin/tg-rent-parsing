import { pool, Db } from "./db.js";
import {
  Filters,
  MAX_ROOMS,
  normalizeFloor,
  normalizePrice,
  normalizeRooms,
  toFilters,
} from "./filters.js";
import { getAccountLimits } from "./subscriptions.js";
import { invalidateAudience } from "./audience.js";
import { log } from "../utils/logger.js";

// The filter set of an account, edited by its owner and editors. Every function returns an
// error message for the user, or null on success; callers check the member's role first.

export const EMPTY_FILTERS: Filters = {
  keywords: [],
  rooms: [],
  floor: { min: null, max: null },
  price: { min: null, max: null, currency: "UAH" },
};

export async function createFilters(accountId: string, db: Db = pool): Promise<void> {
  await db.query("INSERT INTO account_filters (account_id) VALUES ($1) ON CONFLICT DO NOTHING", [accountId]);
}

export async function getFilters(accountId: string): Promise<Filters> {
  const result = await pool.query("SELECT * FROM account_filters WHERE account_id = $1", [accountId]);
  return result.rows[0] ? toFilters(result.rows[0]) : EMPTY_FILTERS;
}

async function update(accountId: string, sql: string, values: unknown[]): Promise<void> {
  await pool.query(
    `INSERT INTO account_filters (account_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [accountId]
  );
  await pool.query(`UPDATE account_filters SET ${sql}, updated_at = NOW() WHERE account_id = $1`, [
    accountId,
    ...values,
  ]);
  invalidateAudience();
}

export async function addKeyword(accountId: string, input: string): Promise<string | null> {
  const keyword = input.trim();
  if (!keyword) return "Ключове слово порожнє";
  if (keyword.length > 100) return "Ключове слово задовге";
  const { keywords } = await getFilters(accountId);
  if (keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) return "Таке ключове слово вже є";
  const { maxKeywords } = await getAccountLimits(accountId);
  if (keywords.length >= maxKeywords) return `Ваш тариф дозволяє до ${maxKeywords} ключових слів`;
  await update(accountId, "keywords = array_append(keywords, $2)", [keyword]);
  log("INFO", "Keyword added", { accountId, keyword });
  return null;
}

export async function removeKeyword(accountId: string, keyword: string): Promise<null> {
  const { keywords } = await getFilters(accountId);
  const kept = keywords.filter((k) => k.toLowerCase() !== keyword.toLowerCase());
  await update(accountId, "keywords = $2", [kept]);
  return null;
}

export async function setRooms(accountId: string, value: unknown): Promise<string | null> {
  const rooms = normalizeRooms(value);
  if (!rooms) return `Кількість кімнат має бути від 1 до ${MAX_ROOMS}`;
  await update(accountId, "rooms = $2", [rooms]);
  return null;
}

export async function setFloor(accountId: string, value: unknown): Promise<string | null> {
  const floor = normalizeFloor(value);
  if (!floor) return "Некоректний діапазон поверхів";
  await update(accountId, "floor_min = $2, floor_max = $3", [floor.min, floor.max]);
  return null;
}

export async function setPrice(accountId: string, value: unknown): Promise<string | null> {
  const price = normalizePrice(value);
  if (!price) return "Некоректний діапазон цін";
  await update(accountId, "price_min = $2, price_max = $3, price_currency = $4", [price.min, price.max, price.currency]);
  return null;
}
