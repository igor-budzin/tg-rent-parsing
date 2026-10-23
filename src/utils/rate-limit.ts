// Allows `limit` hits per key in each window. Keys are dropped once their window has passed, and
// the map is capped, so many different keys can't grow it without bound.
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  // Counts the hit; false when the key is over its limit for the current window
  take(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (entry && now - entry.windowStart < this.windowMs) {
      entry.count++;
      return entry.count <= this.limit;
    }
    this.hits.delete(key);
    if (this.hits.size >= this.maxKeys) this.prune(now);
    this.hits.set(key, { count: 1, windowStart: now });
    return true;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
    // Still nearly full: drop the oldest tenth (a Map iterates in insertion order)
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys * 0.9) break;
      this.hits.delete(key);
    }
  }
}
