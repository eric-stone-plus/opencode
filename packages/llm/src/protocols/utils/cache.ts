// Shared helpers for provider cache-marker lowering. Anthropic enforces a
// 4-breakpoint cap per request and accepts `5m`/`1h` TTL buckets, so the
// counter and TTL mapping live here.

export interface Breakpoints {
  remaining: number
  dropped: number
}

export const newBreakpoints = (cap: number): Breakpoints => ({ remaining: cap, dropped: 0 })

// Returns `"1h"` for any `ttlSeconds >= 3600`, otherwise `undefined` (the
// provider default 5m). Anthropic treats anything shorter than an hour as 5m.
export const ttlBucket = (ttlSeconds: number | undefined): "1h" | undefined =>
  ttlSeconds !== undefined && ttlSeconds >= 3600 ? "1h" : undefined
