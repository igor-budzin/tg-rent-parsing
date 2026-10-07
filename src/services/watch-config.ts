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
  // Small profile photo, downloaded lazily for the web UI; photoId tells when it's stale
  photo?: { photoId: string; data: Buffer };
}

export interface WatchConfigView {
  keywords: string[];
  channels: { name: string; title?: string; photoId?: string; error?: string }[];
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
