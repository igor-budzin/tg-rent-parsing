import { convert } from "./exchange-rates.js";
import { ParsedPost } from "../types/index.js";

// A filter set and the rules for checking a post against it. Pure functions: the filters
// are stored per account (account-filters.ts) and checked for each account in turn.

// Allowed floor range, inclusive; a null end is unbounded
export interface FloorRange {
  min: number | null;
  max: number | null;
}

// Allowed price range in UAH, inclusive; a null end is unbounded
export interface PriceRange {
  min: number | null;
  max: number | null;
}

export interface Filters {
  keywords: string[];
  // Allowed room counts; empty means any
  rooms: number[];
  floor: FloorRange;
  price: PriceRange;
}

const MAX_FLOOR = 200;
// Price filters are always in UAH; post prices in other currencies are converted at NBU rates
const FILTER_CURRENCY = "UAH";
// Room counts selectable in the web UI; the last one also covers anything bigger ("4+")
export const MAX_ROOMS = 4;

export function normalizePrice(value: unknown): PriceRange | null {
  if (!value || typeof value !== "object") return null;
  const { min, max } = value as Record<string, unknown>;
  const valid = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (!valid(min) || !valid(max)) return null;
  const range = { min: min as number | null, max: max as number | null };
  if (range.min !== null && range.max !== null && range.min > range.max) return null;
  return range;
}

export function normalizeFloor(value: unknown): FloorRange | null {
  if (!value || typeof value !== "object") return null;
  const { min, max } = value as Record<string, unknown>;
  const valid = (v: unknown) => v === null || (Number.isInteger(v) && Math.abs(v as number) <= MAX_FLOOR);
  if (!valid(min) || !valid(max)) return null;
  const range = { min: min as number | null, max: max as number | null };
  if (range.min !== null && range.max !== null && range.min > range.max) return null;
  return range;
}

export function normalizeRooms(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((r) => Number.isInteger(r) && r >= 1 && r <= MAX_ROOMS)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

// Row of the account_filters table
export function toFilters(row: any): Filters {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    keywords: row.keywords ?? [],
    rooms: row.rooms ?? [],
    floor: { min: row.floor_min, max: row.floor_max },
    price: { min: num(row.price_min), max: num(row.price_max) },
  };
}

// Keywords are matched as substrings, so a short or generic one matches nearly every post in a
// rental channel: every such post would be sent to the AI and to that account. They're refused
// when added, and ignored when they were stored before this check existed.
const MIN_KEYWORD_LETTERS = 3;
const GENERIC_KEYWORDS = new Set([
  "оренда", "аренда", "здам", "сдам", "здаю", "сдаю", "здається", "сдается",
  "продам", "продаж", "продажа", "квартира", "квартиру", "квартири", "квартиры",
  "кімната", "кімнату", "комната", "комнату", "грн", "uah", "usd", "eur",
]);

// Why a keyword can't be used, or null when it's fine
export function keywordProblem(keyword: string): string | null {
  const letters = keyword.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_KEYWORD_LETTERS) return `Ключове слово має містити щонайменше ${MIN_KEYWORD_LETTERS} літери`;
  if (GENERIC_KEYWORDS.has(keyword.trim().toLowerCase())) {
    return "Надто загальне слово — воно є майже в кожному оголошенні. Вкажіть район, вулицю чи ЖК";
  }
  return null;
}

export function findMatchingKeywords(text: string, keywords: string[]): string[] {
  const lowerText = text.toLowerCase();
  return keywords.filter((keyword) => lowerText.includes(keyword.toLowerCase()));
}

// A post whose room count is unknown passes, so listings aren't lost to a vague post
function roomsMatch(filters: Filters, postRooms: number | null): boolean {
  if (filters.rooms.length === 0 || postRooms === null) return true;
  return filters.rooms.includes(Math.min(postRooms, MAX_ROOMS));
}

// Same rule as rooms: a post without a stated floor passes
function floorMatches({ floor }: Filters, postFloor: number | null): boolean {
  if (postFloor === null) return true;
  return (floor.min === null || postFloor >= floor.min) && (floor.max === null || postFloor <= floor.max);
}

// A post without a price, or whose currency can't be converted, passes
async function priceMatches({ price }: Filters, postPrice: ParsedPost["price"]): Promise<boolean> {
  if (!postPrice || (price.min === null && price.max === null)) return true;
  const amount = await convert(postPrice.amount, postPrice.currency, FILTER_CURRENCY);
  if (amount === null) return true;
  return (price.min === null || amount >= price.min) && (price.max === null || amount <= price.max);
}

// Unparsed posts can't be checked, so they pass
export async function postFitsFilters(filters: Filters, parsed: ParsedPost | null): Promise<boolean> {
  if (!parsed) return true;
  return (
    roomsMatch(filters, parsed.rooms) &&
    floorMatches(filters, parsed.floor) &&
    (await priceMatches(filters, parsed.price))
  );
}
