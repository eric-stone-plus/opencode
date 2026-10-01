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

const RETRYABLE_MESSAGE_PATTERNS = [
  // Status codes only count as a standalone token in a status-like position
  // ("HTTP 503", "status 524", "<500>", leading "429 ..."), never as digits inside
  // request IDs or token counts.
  /(?:^|\b(?:status(?: code)?|code|http(?:\/[\d.]+)?|error)\b[\s:=#"']*|[<([])(?:429|500|502|503|504|524)(?!\w|\.\d)/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|bad gateway|gateway time-?out|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(
  attempt: number,
  error?: SessionV1.APIError,
  random = Math.random(),
  maxDelay?: number,
) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }
    }
  }

  return cap(Math.min(exponential(attempt, random), maxDelay ?? RETRY_MAX_DELAY_NO_HEADERS))
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
  // A wall-clock budget alone means "keep trying until it runs out".
  const attempts =
    opts.budget?.max_attempts ?? (opts.budget?.max_elapsed_ms !== undefined ? Infinity : RETRY_MAX_RETRIES)
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > attempts) return Cause.done(meta.attempt)
      const wait = delay(
        meta.attempt,
        SessionV1.APIError.isInstance(error) ? error : undefined,
        Math.random(),
        opts.budget?.max_delay_ms,
      )
      if (opts.budget?.max_elapsed_ms !== undefined && meta.elapsed + wait > opts.budget.max_elapsed_ms)
        return Cause.done(meta.attempt)
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
