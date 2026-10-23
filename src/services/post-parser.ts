import OpenAI from "openai";
import { OPENROUTER_API_KEY, OPENROUTER_MODELS, OPENROUTER_MAX_RPM } from "../config.js";
import { log } from "../utils/logger.js";
import { ParsedPost } from "../types/index.js";
import { recordParseFailure, ParseFailureReason, PostSource } from "./parse-failures.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// OpenRouter accepts at most this many models in one request's fallback list
const MAX_MODELS_PER_REQUEST = 3;
// After all models are down, skip AI for a while instead of slowing down every post
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
// Per-minute and upstream provider rate limits clear quickly
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

const SYSTEM_PROMPT = `You extract real estate listing data from Telegram posts (usually Ukrainian or Russian).
Return only facts stated in the post; use null when a field is not mentioned.
- type: "rent" for rent/lease (оренда, здам, сдам), "sell" for sale (продаж, продам); null if unclear.
- price: amount as a number; currency as "UAH", "USD" or "EUR" (грн/₴ = UAH, $/дол/у.е. = USD, €/євро = EUR);
  period "month" or "day" for rent, null for sale. null if there is no price.
- location: city, district, street or nearby metro as written in the post, in Ukrainian, concise.
- rooms: number of rooms (1-кімнатна = 1, студія = 1); null if not stated.
- floor: the apartment's floor; totalFloors: floors in the building ("5/9", "5 з 9" = floor 5, totalFloors 9); null if not stated.
- area: total area in square meters (м², кв.м); null if not stated.
- contacts: phone numbers, @usernames and contact links from the post; empty array if none.

Respond with a single JSON object and nothing else, with exactly these keys:
{"type": "rent" | "sell" | null,
 "price": {"amount": number, "currency": "UAH" | "USD" | "EUR", "period": "month" | "day" | null} | null,
 "location": string | null, "rooms": integer | null, "floor": integer | null,
 "totalFloors": integer | null, "area": number | null, "contacts": string[]}`;

// OpenRouter's fallback list isn't part of the OpenAI types; the SDK sends extra body fields as is
type OpenRouterParams = OpenAI.ChatCompletionCreateParamsNonStreaming & { models: string[] };

let client: OpenAI | null = null;
let cooldownUntil = 0;
// Configured models minus the ones OpenRouter doesn't know: one unknown ID fails the whole request
let models = OPENROUTER_MODELS;
let modelsChecked: Promise<void> | null = null;

function getClient(): OpenAI | null {
  if (!OPENROUTER_API_KEY || OPENROUTER_MODELS.length === 0) return null;
  client ??= new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { "X-Title": "tg-rent-parsing" },
    // Free models are slower
    timeout: 30_000,
    // An instant retry of a 429 only spends quota; the retry queue tries again later
    maxRetries: 0,
  });
  return client;
}

export function isAiEnabled(): boolean {
  return getClient() !== null;
}

// When AI requests resume after rate limits or outages; 0 when not paused
export function aiPausedUntil(): number {
  return Date.now() < cooldownUntil ? cooldownUntil : 0;
}

// Reset time as epoch ms; OpenRouter sends ms, but accept seconds too
function toEpochMs(value: unknown): number {
  const n = Number(value);
  return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
}

function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// OpenRouter names its own limit in the message ("free-models-per-day", "free-models-per-min")
// and puts the reset time in error.metadata.headers; upstream providers' 429s carry neither
function cooldownMs(error: InstanceType<typeof OpenAI.APIError>): { ms: number; limit: string } {
  const retryAfterSec = Number(error.headers?.get("retry-after"));
  if (error.status !== 429) {
    return { ms: retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS, limit: "provider_error" };
  }
  if (/per-day/i.test(error.message)) {
    const metadata = (error.error as { metadata?: { headers?: Record<string, unknown> } } | undefined)?.metadata;
    const resetAt =
      toEpochMs(metadata?.headers?.["X-RateLimit-Reset"]) ||
      toEpochMs(error.headers?.get("x-ratelimit-reset")) ||
      nextUtcMidnight();
    return { ms: Math.max(resetAt - Date.now(), RATE_LIMIT_COOLDOWN_MS), limit: "per_day" };
  }
  return {
    ms: retryAfterSec > 0 ? retryAfterSec * 1000 : RATE_LIMIT_COOLDOWN_MS,
    limit: /per-min/i.test(error.message) ? "per_minute" : "upstream",
  };
}

function startCooldown(error: InstanceType<typeof OpenAI.APIError>): void {
  const { ms, limit } = cooldownMs(error);
  cooldownUntil = Date.now() + ms;
  log("WARN", "AI parsing paused", {
    status: error.status,
    limit,
    cooldownSec: Math.round(ms / 1000),
    resumesAt: new Date(cooldownUntil).toISOString(),
  });
}

// Spaces request starts so bursts of posts stay under the per-minute limit
let nextRequestAt = 0;

// How long a request made now would wait for its slot
export function aiQueueWaitMs(): number {
  return Math.max(0, nextRequestAt - Date.now());
}
async function throttle(): Promise<void> {
  if (OPENROUTER_MAX_RPM <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  // Reserve the slot before waiting, so concurrent callers queue up behind each other
  nextRequestAt = Math.max(now, nextRequestAt) + 60_000 / OPENROUTER_MAX_RPM;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// Free models get removed over time; drop unknown ones once instead of failing every post
async function checkModels(): Promise<void> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { data } = (await response.json()) as { data: { id: string }[] };
    const known = new Set(data.map((m) => m.id));
    const unknown = models.filter((m) => !known.has(m));
    if (unknown.length > 0) {
      models = models.filter((m) => known.has(m));
      log("WARN", "Unknown OpenRouter models skipped, update OPENROUTER_MODELS", { unknown, using: models });
    }
  } catch (error) {
    // Keep the configured list; a real problem will show up as a request error
    log("WARN", "Could not check OpenRouter models", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

// Contacts shown in the bot's card; more are dropped
const MAX_CONTACTS = 5;
// Ukrainian numbers have 9 digits after the country code; the model may add or drop the prefix
const PHONE_TAIL_DIGITS = 9;

// The post is written by strangers and may tell the model to report a different number. A contact
// is kept only when it really is in the post: the same digits for a phone number, the same
// @username or link otherwise.
function contactInPost(contact: string, text: string): boolean {
  const digits = contact.replace(/\D/g, "");
  if (digits.length >= 5) return text.replace(/\D/g, "").includes(digits.slice(-PHONE_TAIL_DIGITS));
  const handle = contact.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/^@/, "").replace(/\/+$/, "");
  return handle.length > 0 && text.toLowerCase().includes(handle);
}

function normalize(raw: unknown, text: string): ParsedPost | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const price = data.price as ParsedPost["price"];

  const parsed: ParsedPost = {
    type: data.type === "rent" || data.type === "sell" ? data.type : null,
    price:
      price && typeof price.amount === "number" && price.amount > 0 && typeof price.currency === "string"
        ? { amount: price.amount, currency: price.currency, period: price.period ?? null }
        : null,
    location: typeof data.location === "string" && data.location.trim() ? data.location.trim() : null,
    rooms: positiveNumber(data.rooms),
    // Floor 0 / negative (basement) is still a stated floor
    floor: typeof data.floor === "number" ? data.floor : null,
    totalFloors: positiveNumber(data.totalFloors),
    area: positiveNumber(data.area),
    contacts: Array.isArray(data.contacts)
      ? data.contacts
          .filter((c): c is string => typeof c === "string" && c.trim() !== "" && contactInPost(c, text))
          .slice(0, MAX_CONTACTS)
      : [],
  };

  const isEmpty =
    !parsed.type &&
    !parsed.price &&
    !parsed.location &&
    !parsed.rooms &&
    parsed.floor === null &&
    !parsed.area &&
    parsed.contacts.length === 0;
  return isEmpty ? null : parsed;
}

// Some models wrap JSON in a ```json fence even in JSON mode
function parseJson(content: string): unknown {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

// Index of the model that answered; OpenRouter may report it without the ":free" suffix
function modelIndex(answered: string): number {
  return models.findIndex((m) => m === answered || m.replace(/:free$/, "") === answered);
}

interface ParseAttempt {
  parsed: ParsedPost | null;
  model: string;
  chain: string[];
  content: string | null;
  // Why nothing was extracted, when parsed is null
  reason: "empty_response" | "invalid_json" | "nothing_extracted" | null;
  details: Record<string, unknown>;
  durationMs: number;
}

// Thrown request errors keep the chain and timing for the failure log
class RequestError extends Error {
  constructor(
    readonly cause: unknown,
    readonly chain: string[],
    readonly durationMs: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function requestParse(ai: OpenAI, text: string, startIndex: number): Promise<ParseAttempt> {
  const chain = models.slice(startIndex, startIndex + MAX_MODELS_PER_REQUEST);
  const params: OpenRouterParams = {
    model: chain[0],
    models: chain,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
  };
  const startedAt = Date.now();
  let completion: OpenAI.ChatCompletion;
  try {
    completion = await ai.chat.completions.create(params);
  } catch (error) {
    throw new RequestError(error, chain, Date.now() - startedAt);
  }
  const durationMs = Date.now() - startedAt;

  const choice = completion.choices[0];
  const content = choice?.message?.content ?? null;
  const json = content ? parseJson(content) : null;
  const parsed = json ? normalize(json, text) : null;
  const reason = parsed ? null : !content ? "empty_response" : !json ? "invalid_json" : "nothing_extracted";
  const details = {
    id: completion.id,
    finishReason: choice?.finish_reason ?? null,
    refusal: choice?.message?.refusal ?? null,
    usage: completion.usage ?? null,
    // OpenRouter adds the upstream provider name
    provider: (completion as { provider?: string }).provider ?? null,
  };
  return { parsed, model: completion.model, chain, content, reason, details, durationMs };
}

function recordEmptyAttempt(attempt: ParseAttempt, text: string, source: PostSource | undefined, willRetry: boolean) {
  recordParseFailure({
    reason: attempt.reason ?? "nothing_extracted",
    models: attempt.chain,
    model: attempt.model,
    response: attempt.content,
    details: attempt.details,
    willRetry,
    durationMs: attempt.durationMs,
    postText: text,
    source,
  });
}

function recordRequestError(
  error: RequestError,
  text: string,
  source: PostSource | undefined,
  willRetry: boolean,
): void {
  const cause = error.cause;
  const details: Record<string, unknown> = { errorType: cause instanceof Error ? cause.name : typeof cause };
  let reason: ParseFailureReason = "error";
  let status: number | null = null;

  if (cause instanceof OpenAI.APIConnectionError) {
    reason = "network";
  } else if (cause instanceof OpenAI.APIError) {
    reason = "api_error";
    status = cause.status ?? null;
    details.body = cause.error ?? null;
    details.requestId = cause.requestID ?? null;
    details.retryAfter = cause.headers?.get("retry-after") ?? null;
  } else if (cause instanceof Error) {
    details.stack = cause.stack ?? null;
  }

  recordParseFailure({
    reason,
    models: error.chain,
    status,
    error: error.message,
    details,
    willRetry,
    durationMs: error.durationMs,
    postText: text,
    source,
  });
}

// Worth pausing AI for: rate limits and provider outages, not bad requests
function isTransient(error: RequestError): error is RequestError & { cause: InstanceType<typeof OpenAI.APIError> } {
  const cause = error.cause;
  return cause instanceof OpenAI.APIError && (cause.status === 429 || (cause.status ?? 0) >= 500);
}

// Returns null when AI is disabled, unavailable or extracted nothing — callers then queue the post
// for a retry or send it raw. Every failure is saved for the failures page in the web UI.
export async function parsePost(text: string, source?: PostSource): Promise<ParsedPost | null> {
  const ai = getClient();
  if (!ai) return null;
  // Before the cooldown check: a pause may start while this post waits for its slot
  await throttle();
  if (Date.now() < cooldownUntil) {
    recordParseFailure({
      reason: "cooldown",
      models,
      error: "AI paused after rate limits or provider errors",
      details: { resumesAt: new Date(cooldownUntil).toISOString() },
      postText: text,
      source,
    });
    return null;
  }
  await (modelsChecked ??= checkModels());
  if (models.length === 0) {
    recordParseFailure({
      reason: "no_models",
      models: OPENROUTER_MODELS,
      error: "None of OPENROUTER_MODELS exist on OpenRouter",
      postText: text,
      source,
    });
    return null;
  }

  // A failed request moves on to the models after its chain, so every configured model gets
  // a chance; an empty answer gets one more try with the next model
  let index = 0;
  let emptyRetried = false;
  while (true) {
    if (index > 0) await throttle();
    let attempt: ParseAttempt;
    try {
      attempt = await requestParse(ai, text, index);
    } catch (error) {
      const requestError = error instanceof RequestError ? error : new RequestError(error, [], 0);
      const nextIndex = index + Math.max(requestError.chain.length, 1);
      const willRetry = nextIndex < models.length;
      recordRequestError(requestError, text, source, willRetry);
      if (willRetry) {
        log("WARN", "AI request failed, trying next models", {
          error: requestError.message,
          next: models.slice(nextIndex, nextIndex + MAX_MODELS_PER_REQUEST),
        });
        index = nextIndex;
        continue;
      }
      // Only pause once every model has failed: a free model's shared pool running dry
      // shouldn't stop the others
      if (isTransient(requestError)) startCooldown(requestError.cause);
      log("WARN", "AI parsing failed", { error: requestError.message });
      return null;
    }

    if (attempt.parsed) {
      // Contacts left out: they're phone numbers and names
      const { contacts, ...fields } = attempt.parsed;
      log("DEBUG", "Post parsed by AI", { model: attempt.model, parsed: { ...fields, contacts: contacts.length } });
      return attempt.parsed;
    }

    // The model answered but extracted nothing
    const answeredIndex = modelIndex(attempt.model);
    const nextIndex = answeredIndex === -1 ? index + 1 : answeredIndex + 1;
    const willRetry = !emptyRetried && nextIndex < models.length;
    recordEmptyAttempt(attempt, text, source, willRetry);
    if (!willRetry) {
      log("WARN", "AI extracted nothing", { model: attempt.model, reason: attempt.reason });
      return null;
    }

    log("WARN", "AI extracted nothing, retrying with next model", {
      model: attempt.model,
      reason: attempt.reason,
      next: models[nextIndex],
    });
    emptyRetried = true;
    index = nextIndex;
  }
}
