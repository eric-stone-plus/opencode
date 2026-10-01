import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { isContextOverflow } from "@opencode-ai/llm"

export type Err = ReturnType<NamedError["toObject"]>

export type RetryReason = string & {}

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5
// Transient failures (network drops, rate limits, 5xx, stalled streams) are
// retried against a wall-clock budget instead of a count: a laptop that sleeps
// or switches networks, or a provider outage, outlasts five quick attempts.
export const RETRY_TRANSIENT_BUDGET = 30 * 60_000 // 30 minutes
export const RETRY_TRANSIENT_MAX_DELAY = 5 * 60_000 // 5 minutes

const RETRYABLE_MESSAGE_PATTERNS = [
  // Status codes only count as a standalone token in a status-like position
  // ("HTTP 503", "status 524", "<500>", leading "429 ..."), never as digits inside
  // request IDs or token counts.
  /(?:^|\b(?:status(?: code)?|code|http(?:\/[\d.]+)?|error)\b[\s:=#"']*|[<([])(?:429|500|502|503|504|524)(?!\w|\.\d)/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|bad gateway|gateway time-?out|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  // Bun fetch and AI SDK wording for a request that never reached the server.
  /unable to connect|cannot connect to api|connectionrefused|connectionclosed|econnaborted|ehostunreach|enetunreach|enetdown|network is unreachable/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

// Network-class failures: the request may never have reached the provider.
const NETWORK_MESSAGE_PATTERN =
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection reset|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout|unable to connect|cannot connect to api|connectionrefused|connectionclosed|econnaborted|ehostunreach|enetunreach|enetdown|network is unreachable|timed out|timeout/i
const TRANSIENT_MESSAGE_PATTERN =
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests|too_many_requests|overloaded|exhausted|unavailable|bad gateway|gateway time-?out|at capacity/i
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ZlibError",
  "TimeoutError",
  "ProviderHeaderTimeoutError",
  "ProviderResponseStreamError",
])

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

// Wait requested by the provider's retry-after headers, if any.
export function hint(error: SessionV1.APIError) {
  const headers = error.data.responseHeaders
  if (!headers) return undefined
  const retryAfterMs = headers["retry-after-ms"]
  if (retryAfterMs) {
    const parsedMs = Number.parseFloat(retryAfterMs)
    if (Number.isFinite(parsedMs) && parsedMs >= 0) return cap(parsedMs)
  }

  const retryAfter = headers["retry-after"]
  if (!retryAfter) return undefined
  const parsedSeconds = Number.parseFloat(retryAfter)
  // convert seconds to milliseconds
  if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) return cap(Math.ceil(parsedSeconds * 1000))
  // Try parsing as HTTP date format
  const parsed = Date.parse(retryAfter) - Date.now()
  if (!Number.isNaN(parsed) && parsed > 0) return cap(Math.ceil(parsed))
  return undefined
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random(), maxDelay?: number) {
  const hinted = error ? hint(error) : undefined
  if (hinted !== undefined) return hinted
  return cap(Math.min(exponential(attempt, random), maxDelay ?? RETRY_MAX_DELAY_NO_HEADERS))
}

// Retryable errors that are expected to clear on their own given time: network
// failures, stalled streams, rate limits and server-side (5xx) failures.
export function transient(error: Err) {
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    if (status === 429 || (status !== undefined && status >= 500)) return true
    const code = error.data.metadata?.code
    if (code && TRANSIENT_CODES.has(code)) return true
    if (status !== undefined) return false
    return [error.data.message, error.data.responseBody].some(
      (value) =>
        typeof value === "string" && (NETWORK_MESSAGE_PATTERN.test(value) || TRANSIENT_MESSAGE_PATTERN.test(value)),
    )
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  return (
    typeof message === "string" && (NETWORK_MESSAGE_PATTERN.test(message) || TRANSIENT_MESSAGE_PATTERN.test(message))
  )
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string): Retryable | undefined {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    // Checked first: the moderation body carries request IDs whose digits can
    // match the status-code patterns below.
    if (ProviderError.isModerationRejection(error.data.responseBody)) return undefined
    const status = error.data.statusCode
    // Overflow that slipped past ContextOverflowError classification: resending the
    // same history fails the same way. A 429 "too many tokens" is a rate limit.
    if (status !== 429 && (isOverflowText(error.data.message) || isOverflowText(error.data.responseBody)))
      return undefined
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (isOverflowText(message)) return undefined
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function isOverflowText(value: unknown) {
  return typeof value === "string" && isContextOverflow(value)
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  budget?: ConfigV1.Info["retry"]
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      // Configured retry.* values win. Otherwise transient failures get a
      // wall-clock budget and the rest keep the short count-based default.
      const lasting = transient(error)
      const budget =
        opts.budget?.max_elapsed_ms ??
        (lasting && opts.budget?.max_attempts === undefined ? RETRY_TRANSIENT_BUDGET : undefined)
      // A wall-clock budget alone means "keep trying until it runs out".
      const attempts = opts.budget?.max_attempts ?? (budget !== undefined ? Infinity : RETRY_MAX_RETRIES)
      if (meta.attempt > attempts) return Cause.done(meta.attempt)
      const maxDelay = opts.budget?.max_delay_ms ?? (lasting ? RETRY_TRANSIENT_MAX_DELAY : undefined)
      // retry-after is honored up to the max delay; a longer wait just polls again.
      const hinted = SessionV1.APIError.isInstance(error) ? hint(error) : undefined
      const wait =
        hinted !== undefined
          ? Math.min(hinted, maxDelay ?? RETRY_MAX_DELAY)
          : delay(meta.attempt, undefined, Math.random(), maxDelay)
      if (budget !== undefined && meta.elapsed + wait > budget) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
