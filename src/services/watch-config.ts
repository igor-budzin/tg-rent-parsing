import { TelegramClient, Api, utils } from "telegram";
import { pool } from "./db.js";
import { resolveChannel } from "./telegram-client.js";
import { log } from "../utils/logger.js";

// Keywords and channels being watched. Loaded from the database and edited from the
// web UI; changes take effect immediately without a restart.

interface WatchedChannel {
  name: string;
  entity?: Api.Channel;
  error?: string;
}

export interface WatchConfigView {
  keywords: string[];
  channels: { name: string; title?: string; error?: string }[];
}

let keywords: string[] = [];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveInto(channel: WatchedChannel): Promise<void> {
  if (!client) return;
  try {
    channel.entity = await resolveChannel(client, channel.name);
    channel.error = undefined;
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
  keywords = keywordRows.rows.map((row) => row.keyword);
  channels = channelRows.rows.map((row) => ({ name: row.name }));
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

export function getWatchConfigView(): WatchConfigView {
  return {
    keywords,
    channels: channels.map((ch) => ({
      name: ch.name,
      title: ch.entity?.title,
      error: ch.error,
    })),
  };
}

export async function addKeyword(input: string): Promise<string | null> {
  const keyword = input.trim();
  if (!keyword) return "Keyword is empty";
  if (keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
    return "Keyword already exists";
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
  if (!name) return "Channel is empty";
  if (channels.some((ch) => ch.name.toLowerCase() === name.toLowerCase())) {
    return "Channel already exists";
  }

  const channel: WatchedChannel = { name };
  if (client) {
    await resolveInto(channel);
    if (channel.error) return `Channel not found: ${channel.error}`;
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
