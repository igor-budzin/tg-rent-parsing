import { log } from "../utils/logger.js";

// Official National Bank of Ukraine rates, used to compare prices in different currencies
const NBU_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json";
const CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

// UAH per one unit of currency
let rates: Map<string, number> | null = null;
let nextFetchAt = 0;
// Callers arriving while a refresh is under way wait for it instead of each starting their own
let refreshing: Promise<Map<string, number> | null> | null = null;

function getRates(): Promise<Map<string, number> | null> {
  if (Date.now() < nextFetchAt) return Promise.resolve(rates);
  refreshing ??= refreshRates().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshRates(): Promise<Map<string, number> | null> {
  try {
    const response = await fetch(NBU_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { cc: string; rate: number }[];
    rates = new Map(data.map((row) => [row.cc, row.rate]));
    rates.set("UAH", 1);
    nextFetchAt = Date.now() + CACHE_MS;
  } catch (error) {
    // Keep using the last known rates, if any
    nextFetchAt = Date.now() + RETRY_MS;
    log("WARN", "Could not fetch exchange rates", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return rates;
}

// Returns null when a rate is unknown
export async function convert(amount: number, from: string, to: string): Promise<number | null> {
  if (from === to) return amount;
  const current = await getRates();
  const fromRate = current?.get(from);
  const toRate = current?.get(to);
  if (!fromRate || !toRate) return null;
  return (amount * fromRate) / toRate;
}
