import OpenAI from "openai";
import { OPENROUTER_API_KEY, OPENROUTER_MODELS } from "../config.js";
import { log } from "../utils/logger.js";
import { ParsedPost } from "../types/index.js";
import { recordParseFailure, ParseFailureReason, PostSource } from "./parse-failures.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// OpenRouter accepts at most this many models in one request's fallback list
const MAX_MODELS_PER_REQUEST = 3;
// After all models are rate-limited or down, skip AI for a while instead of slowing down every post
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

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
    maxRetries: 1,
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

function startCooldown(error: InstanceType<typeof OpenAI.APIError>): void {
  const retryAfterSec = Number(error.headers?.get("retry-after"));
  const cooldownMs = retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS;
  cooldownUntil = Date.now() + cooldownMs;
  log("WARN", "AI parsing paused", { status: error.status, cooldownSec: cooldownMs / 1000 });
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

function normalize(raw: unknown): ParsedPost | null {
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
      ? data.contacts.filter((c): c is string => typeof c === "string" && c.trim() !== "")
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
  const parsed = json ? normalize(json) : null;
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

function recordRequestError(error: RequestError, text: string, source: PostSource | undefined): void {
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
    durationMs: error.durationMs,
    postText: text,
    source,
  });
}

// Returns null when AI is disabled, unavailable or extracted nothing — callers then queue the post
// for a retry or send it raw. Every failure is saved for the failures page in the web UI.
export async function parsePost(text: string, source?: PostSource): Promise<ParsedPost | null> {
  const ai = getClient();
  if (!ai) return null;
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

  try {
    const first = await requestParse(ai, text, 0);
    if (first.parsed) {
      log("DEBUG", "Post parsed by AI", { model: first.model, parsed: first.parsed });
      return first.parsed;
    }

    // The model answered but extracted nothing — give the next model one more try
    const answeredIndex = modelIndex(first.model);
    const nextIndex = answeredIndex === -1 ? 1 : answeredIndex + 1;
    const willRetry = nextIndex < models.length;
    recordEmptyAttempt(first, text, source, willRetry);
    if (!willRetry) {
      log("WARN", "AI extracted nothing", { model: first.model, reason: first.reason });
      return null;
    }

    log("WARN", "AI extracted nothing, retrying with next model", {
      model: first.model,
      reason: first.reason,
      next: models[nextIndex],
    });
    const second = await requestParse(ai, text, nextIndex);
    if (second.parsed) {
      log("DEBUG", "Post parsed by AI", { model: second.model, parsed: second.parsed });
    } else {
      recordEmptyAttempt(second, text, source, false);
      log("WARN", "AI extracted nothing", { model: second.model, reason: second.reason });
    }
    return second.parsed;
  } catch (error) {
    const cause = error instanceof RequestError ? error.cause : error;
    if (cause instanceof OpenAI.APIError && (cause.status === 429 || (cause.status ?? 0) >= 500)) {
      startCooldown(cause);
    }
    recordRequestError(
      error instanceof RequestError ? error : new RequestError(error, [], 0),
      text,
      source,
    );
    log("WARN", "AI parsing failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
