import { TelegramClient, Api, utils } from "telegram";
import { pool } from "./db.js";
import { resolveChannel } from "./telegram-client.js";
import { convert } from "./exchange-rates.js";
import { log } from "../utils/logger.js";
import { ParsedPost } from "../types/index.js";

// Keywords and channels being watched. Loaded from the database and edited from the
// web UI; changes take effect immediately without a restart.

interface WatchedChannel {
  name: string;
  entity?: Api.Channel;
  error?: string;
  // Small profile photo, downloaded lazily for the web UI; photoId tells when it's stale
  photo?: { photoId: string; data: Buffer };
}

export interface WatchConfigView {
  keywords: string[];
  channels: { name: string; title?: string; photoId?: string; error?: string }[];
  rooms: number[];
  floor: FloorRange;
  price: PriceRange;
}

// Allowed floor range, inclusive; a null end is unbounded
export interface FloorRange {
  min: number | null;
  max: number | null;
}

const MAX_FLOOR = 200;

// Allowed price range in the given currency, inclusive; a null end is unbounded
export interface PriceRange {
  min: number | null;
  max: number | null;
  currency: string;
}

const CURRENCIES = ["UAH", "USD", "EUR"];

// Room counts selectable in the web UI; the last one also covers anything bigger ("4+")
export const MAX_ROOMS = 4;

let keywords: string[] = [];
// Allowed room counts; empty means any
let rooms: number[] = [];
let floor: FloorRange = { min: null, max: null };
let price: PriceRange = { min: null, max: null, currency: "UAH" };
let channels: WatchedChannel[] = [];
let client: TelegramClient | null = null;

// Accepts "name", "@name", "t.me/name" or "https://t.me/name"
export function normalizeChannelName(input: string): string {
  return input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
}

function photoIdOf(entity: Api.Channel | undefined): string | undefined {
  return entity?.photo instanceof Api.ChatPhoto ? entity.photo.photoId.toString() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Telegram only pushes new posts of channels the account has joined
async function joinIfNeeded(telegramClient: TelegramClient, entity: Api.Channel): Promise<void> {
  if (!(entity instanceof Api.Channel) || !entity.left) return;
  try {
    await telegramClient.invoke(new Api.channels.JoinChannel({ channel: entity }));
    entity.left = false;
    log("INFO", `Joined channel: ${entity.title}`, { username: entity.username });
  } catch (error) {
    log("WARN", `Could not join channel: ${entity.title}`, { error: errorMessage(error) });
  }
}

async function resolveInto(channel: WatchedChannel): Promise<void> {
  if (!client) return;
  try {
    channel.entity = await resolveChannel(client, channel.name);
    channel.error = undefined;
    await joinIfNeeded(client, channel.entity);
  } catch (error) {
    channel.error = errorMessage(error);
    log("ERROR", `Could not find channel: ${channel.name}`, { error: channel.error });
  }
}

export async function loadWatchConfig(): Promise<void> {
  const keywordRows = await pool.query<{ keyword: string }>(
    "SELECT keyword FROM keywords ORDER BY added_at, keyword"
  );
  const channelRows = await pool.query<{ name: string }>(
    "SELECT name FROM channels ORDER BY added_at, name"
  );
  const settingRows = await pool.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM settings"
  );
  const settings = new Map(settingRows.rows.map((row) => [row.key, row.value]));
  keywords = keywordRows.rows.map((row) => row.keyword);
  channels = channelRows.rows.map((row) => ({ name: row.name }));
  rooms = normalizeRooms(settings.get("rooms")) ?? [];
  floor = normalizeFloor(settings.get("floor")) ?? { min: null, max: null };
  price = normalizePrice(settings.get("price")) ?? { min: null, max: null, currency: "UAH" };
}

function normalizePrice(value: unknown): PriceRange | null {
  if (!value || typeof value !== "object") return null;
  const { min, max, currency } = value as Record<string, unknown>;
  const valid = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (!valid(min) || !valid(max) || typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return null;
  }
  const range = { min: min as number | null, max: max as number | null, currency };
  if (range.min !== null && range.max !== null && range.min > range.max) return null;
  return range;
}

async function saveSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

function normalizeFloor(value: unknown): FloorRange | null {
  if (!value || typeof value !== "object") return null;
  const { min, max } = value as Record<string, unknown>;
  const valid = (v: unknown) => v === null || (Number.isInteger(v) && Math.abs(v as number) <= MAX_FLOOR);
  if (!valid(min) || !valid(max)) return null;
  const range = { min: min as number | null, max: max as number | null };
  if (range.min !== null && range.max !== null && range.min > range.max) return null;
  return range;
}

function normalizeRooms(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((r) => Number.isInteger(r) && r >= 1 && r <= MAX_ROOMS)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

// Called once the Telegram client is logged in, so channel names can be resolved
export async function attachClient(telegramClient: TelegramClient): Promise<void> {
  client = telegramClient;
  for (const channel of channels) {
    await resolveInto(channel);
  }
  const resolved = channels.filter((ch) => ch.entity).length;
  log("INFO", `Resolved ${resolved}/${channels.length} channels`);
}

export function getKeywords(): string[] {
  return keywords;
}

// A post whose room count is unknown passes, so listings aren't lost to a vague post
export function roomsMatch(postRooms: number | null): boolean {
  if (rooms.length === 0 || postRooms === null) return true;
  return rooms.includes(Math.min(postRooms, MAX_ROOMS));
}

export async function setRooms(value: unknown): Promise<string | null> {
  const normalized = normalizeRooms(value);
  if (!normalized) return `Кількість кімнат має бути від 1 до ${MAX_ROOMS}`;
  await saveSetting("rooms", normalized);
  rooms = normalized;
  log("INFO", "Room filter changed from web UI", { rooms });
  return null;
}

// Same rule as rooms: a post without a stated floor passes
export function floorMatches(postFloor: number | null): boolean {
  if (postFloor === null) return true;
  return (floor.min === null || postFloor >= floor.min) && (floor.max === null || postFloor <= floor.max);
}

export async function setFloor(value: unknown): Promise<string | null> {
  const normalized = normalizeFloor(value);
  if (!normalized) return "Некоректний діапазон поверхів";
  await saveSetting("floor", normalized);
  floor = normalized;
  log("INFO", "Floor filter changed from web UI", { floor });
  return null;
}

// A post without a price, or whose currency can't be converted, passes
export async function priceMatches(postPrice: ParsedPost["price"]): Promise<boolean> {
  if (!postPrice || (price.min === null && price.max === null)) return true;
  const amount = await convert(postPrice.amount, postPrice.currency, price.currency);
  if (amount === null) return true;
  return (price.min === null || amount >= price.min) && (price.max === null || amount <= price.max);
}

export async function setPrice(value: unknown): Promise<string | null> {
  const normalized = normalizePrice(value);
  if (!normalized) return "Некоректний діапазон цін";
  await saveSetting("price", normalized);
  price = normalized;
  log("INFO", "Price filter changed from web UI", { price });
  return null;
}

export function getChannelNames(): string[] {
  return channels.map((ch) => ch.name);
}

// chatId is the "marked" peer id gramjs exposes as message.chatId
export function findWatchedChannel(
  chatId: string
): { name: string; entity: Api.Channel } | undefined {
  const channel = channels.find(
    (ch) => ch.entity && utils.getPeerId(ch.entity) === chatId
  );
  return channel?.entity ? { name: channel.name, entity: channel.entity } : undefined;
}

export function getResolvedChannels(): { name: string; entity: Api.Channel }[] {
  return channels
    .filter((ch): ch is WatchedChannel & { entity: Api.Channel } => ch.entity instanceof Api.Channel)
    .map((ch) => ({ name: ch.name, entity: ch.entity }));
}

export function getWatchConfigView(): WatchConfigView {
  return {
    keywords,
    channels: channels.map((ch) => ({
      name: ch.name,
      title: ch.entity?.title,
      photoId: photoIdOf(ch.entity),
      error: ch.error,
    })),
    rooms,
    floor,
    price,
  };
}

// Returns null when the channel is unknown, unresolved or has no photo
export async function getChannelPhoto(name: string): Promise<Buffer | null> {
  const channel = channels.find((ch) => ch.name.toLowerCase() === name.toLowerCase());
  const photoId = photoIdOf(channel?.entity);
  if (!client || !channel?.entity || !photoId) return null;
  if (channel.photo?.photoId === photoId) return channel.photo.data;

  const data = await client.downloadProfilePhoto(channel.entity, { isBig: false });
  if (!Buffer.isBuffer(data) || data.length === 0) return null;
  channel.photo = { photoId, data };
  return data;
}

export async function addKeyword(input: string): Promise<string | null> {
  const keyword = input.trim();
  if (!keyword) return "Ключове слово порожнє";
  if (keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
    return "Таке ключове слово вже є";
  }
  await pool.query("INSERT INTO keywords (keyword) VALUES ($1) ON CONFLICT DO NOTHING", [keyword]);
  keywords = [...keywords, keyword];
  log("INFO", "Keyword added from web UI", { keyword });
  return null;
}

export async function removeKeyword(keyword: string): Promise<void> {
  await pool.query("DELETE FROM keywords WHERE lower(keyword) = lower($1)", [keyword]);
  keywords = keywords.filter((k) => k.toLowerCase() !== keyword.toLowerCase());
  log("INFO", "Keyword removed from web UI", { keyword });
}

export async function addChannel(input: string): Promise<string | null> {
  const name = normalizeChannelName(input);
  if (!name) return "Канал не вказано";
  if (channels.some((ch) => ch.name.toLowerCase() === name.toLowerCase())) {
    return "Такий канал уже є";
  }

  const channel: WatchedChannel = { name };
  if (client) {
    await resolveInto(channel);
    if (channel.error) return `Канал не знайдено: ${channel.error}`;
  }

  await pool.query("INSERT INTO channels (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  channels = [...channels, channel];
  log("INFO", "Channel added from web UI", { channel: name, title: channel.entity?.title });
  return null;
}

export async function removeChannel(name: string): Promise<void> {
  await pool.query("DELETE FROM channels WHERE lower(name) = lower($1)", [name]);
  channels = channels.filter((ch) => ch.name.toLowerCase() !== name.toLowerCase());
  log("INFO", "Channel removed from web UI", { channel: name });
}
