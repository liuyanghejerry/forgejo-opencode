/**
 * In-process token-bucket rate limiter.
 *
 * Two independent buckets are exposed via factory:
 *  - one keyed by client IP (for unauthenticated /auth/* endpoints)
 *  - one keyed by session subject (for authenticated proxy traffic)
 *
 * The store is hard-capped to prevent memory-based DoS; when the cap is
 * reached, the oldest entries are evicted.
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimiter {
  /** Returns null when allowed, or seconds-until-retry when rejected. */
  check(key: string): number | null
}

export interface RateLimitOptions {
  /** Maximum tokens (= burst size). */
  capacity: number
  /** Tokens refilled per second. */
  refillPerSecond: number
  /** Max distinct keys tracked (memory cap). */
  maxKeys?: number
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const { capacity, refillPerSecond } = opts
  const maxKeys = opts.maxKeys ?? 10_000
  const buckets = new Map<string, Bucket>()

  return {
    check(key: string): number | null {
      const now = Date.now()
      let bucket = buckets.get(key)

      if (!bucket) {
        if (buckets.size >= maxKeys) {
          // Evict the oldest inserted entry. Map preserves insertion order.
          const firstKey = buckets.keys().next().value
          if (firstKey !== undefined) buckets.delete(firstKey)
        }
        bucket = { tokens: capacity, updatedAt: now }
        buckets.set(key, bucket)
      } else {
        const elapsedSec = (now - bucket.updatedAt) / 1000
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond)
        bucket.updatedAt = now
        // Refresh insertion order so active keys are not evicted.
        buckets.delete(key)
        buckets.set(key, bucket)
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return null
      }

      const deficit = 1 - bucket.tokens
      const retryAfter = Math.ceil(deficit / refillPerSecond)
      return Math.max(1, retryAfter)
    },
  }
}

/**
 * Extract a best-effort client IP. When `behindProxy` is true, the leftmost
 * X-Forwarded-For entry is used; otherwise the socket address is preferred
 * and we fall back to the header only when no socket info is available.
 */
export function getClientIp(
  request: Request,
  socketAddr: string | undefined,
  behindProxy: boolean,
): string {
  if (behindProxy) {
    const xff = request.headers.get("x-forwarded-for")
    if (xff) {
      const first = xff.split(",")[0]?.trim()
      if (first) return first
    }
    const realIp = request.headers.get("x-real-ip")
    if (realIp) return realIp.trim()
  }
  return socketAddr ?? "unknown"
}
