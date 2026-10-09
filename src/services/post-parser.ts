import OpenAI from "openai";
import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import { log } from "../utils/logger.js";
import { ParsedPost } from "../types/index.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
// After a rate limit or outage, skip AI for a while instead of slowing down every post
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
- contacts: phone numbers, @usernames and contact links from the post; empty array if none.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    type: { type: ["string", "null"], enum: ["rent", "sell", null] },
    price: {
      type: ["object", "null"],
      properties: {
        amount: { type: "number" },
        currency: { type: "string", enum: ["UAH", "USD", "EUR"] },
        period: { type: ["string", "null"], enum: ["month", "day", null] },
      },
      required: ["amount", "currency", "period"],
      additionalProperties: false,
    },
    location: { type: ["string", "null"] },
    rooms: { type: ["integer", "null"] },
    floor: { type: ["integer", "null"] },
    totalFloors: { type: ["integer", "null"] },
    area: { type: ["number", "null"] },
    contacts: { type: "array", items: { type: "string" } },
  },
  required: ["type", "price", "location", "rooms", "floor", "totalFloors", "area", "contacts"],
  additionalProperties: false,
};

let client: OpenAI | null = null;
let cooldownUntil = 0;

function getClient(): OpenAI | null {
  if (!GEMINI_API_KEY) return null;
  client ??= new OpenAI({
    apiKey: GEMINI_API_KEY,
    baseURL: GEMINI_BASE_URL,
    timeout: 20_000,
    maxRetries: 1,
  });
  return client;
}

function startCooldown(error: InstanceType<typeof OpenAI.APIError>): void {
  const retryAfterSec = Number(error.headers?.get("retry-after"));
  const cooldownMs = retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS;
  cooldownUntil = Date.now() + cooldownMs;
  log("WARN", "AI parsing paused", { status: error.status, cooldownSec: cooldownMs / 1000 });
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

// Returns null when AI is disabled, unavailable or extracted nothing — callers then send the raw post
export async function parsePost(text: string): Promise<ParsedPost | null> {
  const ai = getClient();
  if (!ai || Date.now() < cooldownUntil) return null;

  try {
    const completion = await ai.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "listing", schema: RESPONSE_SCHEMA, strict: true },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      log("WARN", "AI returned an empty response");
      return null;
    }

    const parsed = normalize(JSON.parse(content));
    log("DEBUG", "Post parsed by AI", { parsed });
    return parsed;
  } catch (error) {
    if (error instanceof OpenAI.APIError && (error.status === 429 || (error.status ?? 0) >= 500)) {
      startCooldown(error);
    }
    log("WARN", "AI parsing failed, sending raw post", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
