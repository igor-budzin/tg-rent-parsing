import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { log } from "../utils/logger.js";
import { findWatchedChannel, getResolvedChannels } from "../services/watch-config.js";
import { AI_DAILY_PARSES_PER_ACCOUNT, CHECK_INTERVAL_MS, PARSE_RETRY_ATTEMPTS, PARSE_RETRY_DELAY_MS } from "../config.js";
import { sendPostToChat, PostCaption, CAPTION_LIMIT, MESSAGE_LIMIT } from "../services/notification.js";
import { parsePost, isAiEnabled, aiQueueWaitMs } from "../services/post-parser.js";
import { recordParseFailure } from "../services/parse-failures.js";
import { mapLimit } from "../utils/concurrency.js";
import { enqueuePost } from "../services/parse-queue.js";
import { getAudience, getAllKeywords, AudienceAccount } from "../services/audience.js";
import { findMatchingKeywords, postFitsFilters } from "../services/filters.js";
import { savePost, getDeliveredUserIds, recordDeliveries } from "../services/posts.js";
import { escapeHtml } from "../services/bot-api.js";
import { recordPostStat } from "../services/post-stats.js";
import { MessageStats, ParsedPost } from "../types/index.js";

// Max posts fetched per channel per poll
const POLL_BATCH_LIMIT = 100;
// Telegram albums hold up to 10 media, posted as consecutive messages
const MAX_ALBUM_SIZE = 10;
// Accounts a post is sent to at once; they share the Bot API throttle in notification.ts
const DELIVERY_CONCURRENCY = 4;
// Matched posts handled at once. More go to the parse queue (database) instead of piling up in memory.
const MAX_IN_FLIGHT_POSTS = 50;
// A post that would wait longer than this for an AI slot is sent unparsed, so a burst of posts
// doesn't delay every one of them by minutes
const MAX_AI_WAIT_MS = 60_000;
// Posts whose handling failed (database or Telegram trouble) are tried again from the parse queue
const HANDLING_RETRY_DELAY_MS = 60_000;

// Cuts text to max characters, ending with "…"
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "";
  let cut = text.slice(0, max - 1);
  // Don't leave half of a surrogate pair (an emoji) at the end
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + "…";
}

// Length as Telegram counts it against its limits: without tags, an entity as one character
function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt);/g, "_").length;
}

async function downloadAlbumPhotos(
  client: TelegramClient,
  channelEntity: Api.Channel,
  message: Api.Message,
  groupedId: Api.long
): Promise<Buffer[]> {
  // Look around the post itself, so older posts (retried from the parse queue) work too
  const ids = Array.from({ length: MAX_ALBUM_SIZE * 2 - 1 }, (_, i) => message.id - MAX_ALBUM_SIZE + 1 + i);
  const messages = await client.getMessages(channelEntity, { ids });

  const albumMessages = messages.filter((m) => m?.groupedId?.equals(groupedId));
  const photoBuffers: Buffer[] = [];

  for (const albumMsg of albumMessages) {
    if (albumMsg.photo) {
      const buffer = (await client.downloadMedia(albumMsg, {})) as Buffer;
      if (buffer) {
        photoBuffers.push(buffer);
      }
    }
  }

  return photoBuffers;
}

const PRICE_PERIODS = { month: " / міс.", day: " / доба" } as const;

function formatParsedCaption(
  parsed: ParsedPost,
  channelTitle: string,
  messageLink: string
): string {
  const lines: string[] = [];
  if (parsed.type === "rent") lines.push("🏠 <b>ОРЕНДА</b>");
  if (parsed.type === "sell") lines.push("🏷 <b>ПРОДАЖ</b>");
  if (parsed.price) {
    const { amount, currency, period } = parsed.price;
    const formatted = amount.toLocaleString("uk-UA");
    lines.push(
      `💰 <b>Ціна:</b> ${formatted} ${escapeHtml(currency)}${period ? PRICE_PERIODS[period] ?? "" : ""}`
    );
  }
  // AI output is capped, so the caption stays well under Telegram's 1024-character caption limit
  if (parsed.location) lines.push(`📍 <b>Локація:</b> ${escapeHtml(truncate(parsed.location, 200))}`);
  if (parsed.rooms) lines.push(`🚪 <b>Кімнат:</b> ${parsed.rooms}`);
  if (parsed.area) lines.push(`📐 <b>Площа:</b> ${parsed.area.toLocaleString("uk-UA")} м²`);
  if (parsed.floor !== null) {
    const total = parsed.totalFloors ? `/${parsed.totalFloors}` : "";
    lines.push(`🏢 <b>Поверх:</b> ${parsed.floor}${total}`);
  }
  if (parsed.contacts.length > 0) {
    // Up to ~300 characters of contacts; with the 200-character location and a 128-character
    // channel title (Telegram's maximum) the caption stays under 1024
    const contacts: string[] = [];
    let length = 0;
    for (const contact of parsed.contacts) {
      const shown = truncate(contact, 64);
      if (contacts.length > 0 && length + shown.length > 300) break;
      contacts.push(shown);
      length += shown.length + 2;
    }
    lines.push(`📞 <b>Контакти:</b> ${contacts.map(escapeHtml).join(", ")}`);
  }

  return `${lines.join("\n")}\n\n<b>Канал:</b> ${escapeHtml(channelTitle)}\n${messageLink}`;
}

// The post's photos, downloaded once for all recipients; none when there are none or they fail
async function downloadPhotos(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel
): Promise<Buffer[]> {
  try {
    if (message.groupedId) {
      return await downloadAlbumPhotos(client, channelEntity, message, message.groupedId);
    }
    if (message.photo) {
      const photoBuffer = (await client.downloadMedia(message, {})) as Buffer;
      return photoBuffer ? [photoBuffer] : [];
    }
  } catch (error) {
    log("ERROR", "Failed to download post photos", { error });
  }
  return [];
}

// The post text is shortened so the whole message fits the limit; the header and link stay whole
function formatRawCaption(
  message: Api.Message,
  channelTitle: string,
  keywords: string[],
  messageLink: string,
  limit: number
): string {
  const head = `<b>Match found!</b>

<b>Channel:</b> ${escapeHtml(channelTitle)}
<b>Keywords:</b> ${escapeHtml(truncate(keywords.join(", "), 200))}

`;
  const tail = `

${messageLink}`;
  const room = Math.max(0, limit - visibleLength(head) - visibleLength(tail));
  return head + escapeHtml(truncate(message.message, room)) + tail;
}

function formatCaption(
  message: Api.Message,
  channelTitle: string,
  keywords: string[],
  messageLink: string,
  parsed: ParsedPost | null
): PostCaption {
  if (parsed) {
    const caption = formatParsedCaption(parsed, channelTitle, messageLink);
    return { media: caption, text: caption };
  }
  return {
    media: formatRawCaption(message, channelTitle, keywords, messageLink, CAPTION_LIMIT),
    text: formatRawCaption(message, channelTitle, keywords, messageLink, MESSAGE_LIMIT),
  };
}

// Each account with an active subscription gets the post when it contains one of the
// account's keywords and, if parsed, fits its room, floor and price filters. Unparsed posts
// skip the filters. Users who already got the post (a retry or a repost) are skipped.
export async function deliverPost(
  client: TelegramClient,
  message: Api.Message,
  channelEntity: Api.Channel,
  channelTitle: string,
  _matchedKeywords: string[],
  messageLink: string,
  parsed: ParsedPost | null
): Promise<void> {
  const targets: { account: AudienceAccount; keywords: string[] }[] = [];
  for (const account of await getAudience()) {
    const keywords = findMatchingKeywords(message.message, account.filters.keywords);
    if (keywords.length > 0 && (await postFitsFilters(account.filters, parsed))) {
      targets.push({ account, keywords });
    }
  }

  if (targets.length === 0) {
    log("INFO", "Post skipped: no account's filters fit it", {
      channel: channelTitle,
      messageId: message.id,
      rooms: parsed?.rooms,
      floor: parsed?.floor,
      price: parsed?.price,
    });
    recordPostStat(channelTitle, "filtered_out");
    return;
  }

  const postId = await savePost({
    channelId: channelEntity.id.toString(),
    messageId: message.id,
    channelTitle,
    messageLink,
    text: message.message,
    parsed,
  });
  const alreadyDelivered = await getDeliveredUserIds(postId);
  const photos = await downloadPhotos(client, message, channelEntity);

  // A user is in one account at a time, so accounts never share a recipient and can be sent to
  // in parallel; the shared Bot API throttle still paces the requests
  const sentPerAccount = await mapLimit(targets, DELIVERY_CONCURRENCY, async ({ account, keywords }) => {
    const caption = formatCaption(message, channelTitle, keywords, messageLink, parsed);
    const delivered: { userId: string; accountId: string }[] = [];
    for (const recipient of account.recipients) {
      if (alreadyDelivered.has(recipient.userId)) continue;
      alreadyDelivered.add(recipient.userId);
      if (await sendPostToChat(recipient.chatId, photos, caption)) {
        delivered.push({ userId: recipient.userId, accountId: account.accountId });
      }
    }
    // Recorded per account, so a crash halfway doesn't resend to those already reached
    await recordDeliveries(postId, delivered);
    return delivered.length;
  });
  const sentCount = sentPerAccount.reduce((sum, n) => sum + n, 0);

  log("INFO", "Post delivered", { channel: channelTitle, messageId: message.id, accounts: targets.length, recipients: sentCount });
  if (sentCount > 0) recordPostStat(channelTitle, "sent");
}

// AI parses charged to each account today, see AI_DAILY_PARSES_PER_ACCOUNT. In memory: a
// restart resets it, which at worst lets an account spend its budget twice in a day.
let aiBudgetDay = "";
const aiParsesToday = new Map<string, number>();

// Charges the parse to every account that wants the post and still has budget; false when none
// has, so the post goes out unparsed. Retries from the parse queue aren't charged again.
function takeAiBudget(accountIds: string[]): boolean {
  if (AI_DAILY_PARSES_PER_ACCOUNT <= 0) return true;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== aiBudgetDay) {
    aiBudgetDay = today;
    aiParsesToday.clear();
  }
  const withBudget = accountIds.filter((id) => (aiParsesToday.get(id) ?? 0) < AI_DAILY_PARSES_PER_ACCOUNT);
  for (const id of withBudget) {
    const used = (aiParsesToday.get(id) ?? 0) + 1;
    aiParsesToday.set(id, used);
    if (used === AI_DAILY_PARSES_PER_ACCOUNT) {
      log("WARN", "Account used its daily AI parse budget, its posts are sent unparsed until tomorrow (UTC)", {
        accountId: id,
        limit: AI_DAILY_PARSES_PER_ACCOUNT,
      });
    }
  }
  return withBudget.length > 0;
}

// A post that matched the union of all keywords and is waiting to be parsed and delivered
interface MatchedPost {
  client: TelegramClient;
  message: Api.Message;
  channelEntity: Api.Channel;
  channelTitle: string;
  matchedKeywords: string[];
  messageLink: string;
}

// Hands a post to the parse queue, whose retry loop parses and delivers it later. Used when
// handling it now failed or too many posts are in progress; it's lost only if the database is
// unreachable too.
async function deferPost(post: MatchedPost, reason: unknown): Promise<void> {
  const context = {
    channel: post.channelTitle,
    messageId: post.message.id,
    link: post.messageLink,
    reason: reason instanceof Error ? reason.message : String(reason),
  };
  try {
    await enqueuePost(
      {
        channelId: post.channelEntity.id.toString(),
        messageId: post.message.id,
        channelTitle: post.channelTitle,
        messageLink: post.messageLink,
        keywords: post.matchedKeywords,
      },
      HANDLING_RETRY_DELAY_MS
    );
    log("WARN", "Post deferred to the parse queue", { ...context, retryInSec: HANDLING_RETRY_DELAY_MS / 1000 });
  } catch (error) {
    log("ERROR", "Post lost: could not handle it or queue it for later", {
      ...context,
      queueError: error instanceof Error ? error.message : String(error),
    });
  }
}

// A post the AI fails to parse goes to the parse queue and is retried later;
// it's sent unparsed only when retries are off or the queue can't be written
async function handleNotification(post: MatchedPost): Promise<void> {
  const { client, message, channelEntity, channelTitle, matchedKeywords, messageLink } = post;
  const deliver = (parsed: ParsedPost | null) =>
    deliverPost(client, message, channelEntity, channelTitle, matchedKeywords, messageLink, parsed);

  if (!isAiEnabled()) return deliver(null);

  const wantedBy = (await getAudience())
    .filter((account) => findMatchingKeywords(message.message, account.filters.keywords).length > 0)
    .map((account) => account.accountId);

  // From here to parsePost reserving its AI slot there's no await, so the wait checked is the
  // wait this post gets, and no budget is charged for a post that skips the AI
  const waitMs = aiQueueWaitMs();
  if (waitMs > MAX_AI_WAIT_MS) {
    recordParseFailure({
      reason: "backlog",
      models: [],
      error: `AI queue too long (${Math.round(waitMs / 1000)}s), post sent unparsed`,
      postText: message.message,
      source: { channel: channelTitle, messageLink, attempt: 0, queueOnFailure: false },
    });
    log("INFO", "Post sent unparsed: AI backlog", { channel: channelTitle, messageId: message.id, waitSec: Math.round(waitMs / 1000) });
    return deliver(null);
  }
  if (!takeAiBudget(wantedBy)) {
    log("INFO", "Post sent unparsed: every account that wants it used its daily AI budget", {
      channel: channelTitle,
      messageId: message.id,
      accounts: wantedBy,
    });
    return deliver(null);
  }

  const queueOnFailure = PARSE_RETRY_ATTEMPTS > 0;
  const parsed = await parsePost(message.message, {
    channel: channelTitle,
    messageLink,
    attempt: 0,
    queueOnFailure,
  });
  if (parsed || !queueOnFailure) return deliver(parsed);

  try {
    await enqueuePost(
      {
        channelId: channelEntity.id.toString(),
        messageId: message.id,
        channelTitle,
        messageLink,
        keywords: matchedKeywords,
      },
      PARSE_RETRY_DELAY_MS
    );
    log("INFO", "Post queued for another AI parse attempt", {
      channel: channelTitle,
      messageId: message.id,
      retryInSec: PARSE_RETRY_DELAY_MS / 1000,
    });
  } catch (error) {
    log("WARN", "Could not queue post for retry, sending raw", {
      error: error instanceof Error ? error.message : String(error),
    });
    await deliver(null);
  }
}

function buildMessageLink(channelEntity: Api.Channel, messageId: number): string {
  return channelEntity.username
    ? `https://t.me/${channelEntity.username}/${messageId}`
    : `https://t.me/c/${channelEntity.id.toString()}/${messageId}`;
}

// Highest message id already handled per channel, shared by the event handler and the
// poller so each post is notified once
const lastProcessedIds = new Map<string, number>();

// Channels are only watched while some account can receive notifications
let paused = false;

// Matched posts being parsed or delivered right now, see MAX_IN_FLIGHT_POSTS
let inFlightPosts = 0;

async function isWatching(): Promise<boolean> {
  let watching: boolean;
  try {
    watching = (await getAudience()).length > 0;
  } catch (error) {
    log("WARN", "Could not check accounts, keeping current watch state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return !paused;
  }
  if (watching === paused) {
    paused = !watching;
    log("INFO", watching
      ? "Active account present, resuming channel watching"
      : "No account with an active subscription, pausing channel watching");
  }
  if (!watching) {
    // Forget progress so posts published while paused are not replayed on resume
    lastProcessedIds.clear();
  }
  return watching;
}

async function processChannelMessage(
  client: TelegramClient,
  message: Api.Message,
  watched: { name: string; entity: Api.Channel },
  stats: MessageStats,
  source: "event" | "poll"
): Promise<void> {
  const { name: channelName, entity: channelEntity } = watched;
  const channelKey = channelEntity.id.toString();
  if (message.id <= (lastProcessedIds.get(channelKey) ?? 0)) return;
  lastProcessedIds.set(channelKey, message.id);

  if (!message.message) return;

  stats.messageCount++;
  const messageText = message.message;
  const channelTitle = channelEntity.title || channelName;
  recordPostStat(channelTitle, "checked");

  log("INFO", `New message received from ${channelTitle}`, {
    source,
    messageId: message.id,
    textPreview:
      messageText.substring(0, 100) +
      (messageText.length > 100 ? "..." : ""),
    textLength: messageText.length,
    date: message.date
      ? new Date(message.date * 1000).toISOString()
      : "unknown",
  });

  // The message id is already marked handled, so from here a failure must defer the post to the
  // parse queue rather than drop it
  const post: MatchedPost = {
    client,
    message,
    channelEntity,
    channelTitle,
    matchedKeywords: [],
    messageLink: buildMessageLink(channelEntity, message.id),
  };
  try {
    post.matchedKeywords = findMatchingKeywords(messageText, await getAllKeywords());
  } catch (error) {
    await deferPost(post, error);
    return;
  }

  if (post.matchedKeywords.length > 0) {
    stats.matchCount++;
    recordPostStat(channelTitle, "matched");

    log("INFO", `KEYWORD MATCH FOUND!`, {
      channel: channelTitle,
      matchedKeywords: post.matchedKeywords,
      messageId: message.id,
      link: post.messageLink,
      totalMatches: stats.matchCount,
    });

    // Not awaited: the AI wait and the deliveries of one post don't hold up the next posts
    if (inFlightPosts >= MAX_IN_FLIGHT_POSTS) {
      await deferPost(post, `${inFlightPosts} posts already in progress`);
      return;
    }
    inFlightPosts++;
    void handleNotification(post)
      .catch((error) => deferPost(post, error))
      .finally(() => inFlightPosts--);
  } else {
    log("DEBUG", "No keywords matched in message", {
      channel: channelTitle,
      messageId: message.id,
    });
  }
}

export function setupMessageHandler(client: TelegramClient, stats: MessageStats): void {
  log("DEBUG", "Setting up NewMessage event handler");

  // No chats filter: the watched channel list can change at runtime (web UI),
  // so each message is checked against the current list instead
  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message) return;

      const chatId = message.chatId?.toString();
      const watched = chatId ? findWatchedChannel(chatId) : undefined;
      if (!watched) return;
      if (!(await isWatching())) return;

      await processChannelMessage(client, message, watched, stats, "event");
    },
    new NewMessage({})
  );

  log("INFO", "Event handler registered successfully");
}

// Telegram does not reliably push updates for busy channels, so every channel is also
// polled for posts newer than the last one handled
async function pollChannels(client: TelegramClient, stats: MessageStats): Promise<void> {
  if (!(await isWatching())) return;

  for (const watched of getResolvedChannels()) {
    const channelKey = watched.entity.id.toString();
    try {
      const lastId = lastProcessedIds.get(channelKey);
      if (lastId === undefined) {
        // First poll of this channel: start from its newest post, don't replay history
        const [latest] = await client.getMessages(watched.entity, { limit: 1 });
        lastProcessedIds.set(channelKey, latest?.id ?? 0);
        continue;
      }

      const messages = await client.getMessages(watched.entity, {
        minId: lastId,
        limit: POLL_BATCH_LIMIT,
      });
      // getMessages returns newest first
      for (const message of [...messages].reverse()) {
        await processChannelMessage(client, message, watched, stats, "poll");
      }
    } catch (error) {
      log("WARN", `Polling failed for channel: ${watched.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startChannelPolling(client: TelegramClient, stats: MessageStats): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollChannels(client, stats);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(tick, CHECK_INTERVAL_MS);
  log("INFO", `Polling channels every ${CHECK_INTERVAL_MS / 1000}s`);
}
