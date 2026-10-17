export * as DeepSeek from "./deepseek.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Provider } from "@opencode/schema/provider"
import type { WebSearch } from "@opencode/schema/websearch"
import { Clock, Duration, Effect, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { App } from "./app.js"
import { collectBoundedResponseBody } from "./tool/http-body.js"

/**
 * The fork's only provider is DeepSeek (ADR 0009). Native chat, model metadata,
 * Search and Fetch all live on the OpenAI-compatible base below. `/anthropic` is
 * the Anthropic-compatible chat surface and does not expose `/v1/tools/*`
 * (measured 2026-10-17: both tool paths return 404 there).
 *
 * The endpoint is a constant, not provider config: a project config that
 * re-points `baseURL` must not be able to move the API key to another host.
 */
export const DEEPSEEK = "deepseek"
export const BASE_URL = "https://api.deepseek.com"
export const MODELS_URL = `${BASE_URL}/models`
export const SEARCH_URL = `${BASE_URL}/v1/tools/search`
export const FETCH_URL = `${BASE_URL}/v1/tools/fetch`

/**
 * Measured 2026-10-17 against the live API (see the delivery report):
 *
 * - count=5/10/20 all answered in ~350-390 ms; count does not change latency.
 * - count=5 with `need_content=false` returned 11.5 KB / 7.7 K chars of
 *   summaries; count=10 doubled that and count=20 quadrupled it. Five results
 *   is the context-optimal default for an agent tool: the model can fetch any
 *   page it actually needs with `webfetch`.
 * - `need_content=true` raised the same count=5 response to 38 KB (25.7 K chars
 *   of page content), so the summary field is the right payload for discovery.
 * - A six-request burst produced one 429 with "Your current QPS: 5", so the
 *   limiter admits five requests per rolling second. Search and Fetch have
 *   independent account quotas, so each gets its own limiter.
 */
export const SEARCH_COUNT = 5
export const SEARCH_NEED_CONTENT = false
export const SEARCH_QPS = 5
export const FETCH_QPS = 5
export const SEARCH_TIMEOUT_SECONDS = 20
export const FETCH_TIMEOUT_SECONDS = 30
export const MAX_ATTEMPTS = 3

const MAX_SEARCH_BYTES = 1_000_000
const MAX_FETCH_BYTES = 5 * 1024 * 1024
const MAX_SUMMARY_CHARS = 2_000
const DEFAULT_USER_AGENT = "OpenCode/1.0"

const SearchItem = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
})
const SearchResponse = Schema.Struct({
  results: Schema.Array(SearchItem),
})
const FetchResponse = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.String,
})

class DeepSeekTimeout extends Schema.TaggedError<DeepSeekTimeout>()("DeepSeek.Timeout", {}) {}

export interface Credential {
  readonly key: string
  readonly provider: Provider.Info
}

export interface RequestOptions {
  readonly userAgent?: string
}

interface Limiter {
  readonly acquire: Effect.Effect<void>
}

/**
 * Sliding-window limiter: at most `limit` acquisitions in any `windowMillis`
 * window. A plain semaphore would allow a burst of `limit` requests per
 * request-latency rather than per second and still trigger the account QPS cap.
 */
const makeLimiter = (limit: number, windowMillis = 1_000): Limiter => {
  const stamps: number[] = []
  const lock = Semaphore.makeUnsafe(1)
  const acquire = lock.withPermit(
    Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis
        while (true) {
          const oldest = stamps[0]
          if (oldest === undefined || now - oldest < windowMillis) break
          stamps.shift()
        }
        if (stamps.length < limit) {
          stamps.push(now)
          return
        }
        const oldest = stamps[0]
        if (oldest === undefined) {
          stamps.push(now)
          return
        }
        yield* Effect.sleep(Duration.millis(Math.max(windowMillis - (now - oldest) + 1, 1)))
      }
    }),
  )
  return { acquire }
}

const searchLimiter = makeLimiter(SEARCH_QPS)
const fetchLimiter = makeLimiter(FETCH_QPS)

export const searchBody = (query: string) => ({
  query,
  count: SEARCH_COUNT,
  need_content: SEARCH_NEED_CONTENT,
})

export const credential = (ctx: Context): Effect.Effect<Credential | undefined, unknown> =>
  Effect.gen(function* () {
    const provider = (yield* ctx.provider.list()).data.find((item) => item.id === DEEPSEEK)
    if (!provider || provider.activation === "disabled") return undefined
    const connection = yield* ctx.integration.connection.active(provider.integrationID ?? provider.id)
    // Resolving an OAuth connection can refresh its token; these tool calls only
    // ever use a plain API key.
    if (connection?.type === "credential" && connection.method !== "key") return undefined
    const value = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
    if (value?.type !== "key") return undefined
    return { key: value.key, provider }
  })

const retryAfterMillis = (value: string | undefined) => {
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

const retryable = (error: unknown) => {
  if (error instanceof DeepSeekTimeout) return true
  if (!HttpClientError.isHttpClientError(error)) return false
  const status = error.response?.status
  return status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)
}

const backoff = (attempt: number, error: unknown) => {
  const retryAfter = HttpClientError.isHttpClientError(error)
    ? retryAfterMillis(error.response?.headers["retry-after"])
    : undefined
  const base = retryAfter ?? Math.min(500 * 2 ** attempt, 8_000)
  const jitter = base === 0 ? 0 : Math.floor(Math.random() * 250)
  return Duration.millis(Math.min(base + jitter, 30_000))
}

const status = (error: unknown) =>
  HttpClientError.isHttpClientError(error) ? error.response?.status : undefined

const request = (
  http: HttpClient.HttpClient,
  url: string,
  key: string,
  body: unknown,
  timeoutSeconds: number,
  limiter: Limiter,
  maximumBytes: number,
  userAgent: string,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    let attempt = 0
    while (true) {
      yield* limiter.acquire
      const result = yield* http
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.setHeader("Accept", "application/json"),
            HttpClientRequest.setHeader("User-Agent", userAgent),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) =>
            collectBoundedResponseBody(response, maximumBytes, () => new Error("DeepSeek response too large")),
          ),
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.timeoutOrElse({
            duration: Duration.seconds(timeoutSeconds),
            orElse: () => Effect.fail(new DeepSeekTimeout()),
          }),
          Effect.result,
        )
      if (result._tag === "Success") return result.success
      const error = result.failure
      if (attempt + 1 >= MAX_ATTEMPTS || !retryable(error)) return yield* Effect.fail(error)
      yield* Effect.logDebug("deepseek request retry", { url, attempt, status: status(error) })
      yield* Effect.sleep(backoff(attempt, error))
      attempt += 1
    }
  })

const truncate = (value: string | undefined) => {
  if (value === undefined) return undefined
  // Count code points, not UTF-16 units: a slice at the boundary can split a
  // surrogate pair and emit U+FFFD into the model's context.
  const points = Array.from(value)
  return points.length <= MAX_SUMMARY_CHARS ? value : `${points.slice(0, MAX_SUMMARY_CHARS).join("")}…`
}

const published = (value: string | null | undefined) => {
  if (!value) return {}
  const time = Date.parse(value)
  return Number.isFinite(time) ? { published: time } : {}
}

export const searchWithKey = (
  http: HttpClient.HttpClient,
  key: string,
  query: string,
  options: RequestOptions = {},
): Effect.Effect<readonly WebSearch.Result[], unknown> =>
  Effect.gen(function* () {
    const text = yield* request(
      http,
      SEARCH_URL,
      key,
      searchBody(query),
      SEARCH_TIMEOUT_SECONDS,
      searchLimiter,
      MAX_SEARCH_BYTES,
      options.userAgent ?? DEFAULT_USER_AGENT,
    )
    const parsed = yield* Effect.try(() => JSON.parse(text))
    const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)(parsed)
    return decoded.results.map((item) => ({
      url: item.url,
      title: item.title || undefined,
      content: truncate(item.summary || item.snippet || item.content || undefined),
      time: published(item.date),
    }))
  })

export const search = (
  ctx: Context,
  http: HttpClient.HttpClient,
  query: string,
): Effect.Effect<readonly WebSearch.Result[], unknown> =>
  Effect.gen(function* () {
    const resolved = yield* credential(ctx)
    if (!resolved) return yield* Effect.fail(new Error("DeepSeek API key is not configured"))
    return yield* searchWithKey(http, resolved.key, query, { userAgent: App.useragent(ctx.app) })
  })

export const fetchWithKey = (
  http: HttpClient.HttpClient,
  key: string,
  url: string,
  timeoutSeconds = FETCH_TIMEOUT_SECONDS,
  options: RequestOptions = {},
): Effect.Effect<{ readonly title?: string; readonly content: string }, unknown> =>
  Effect.gen(function* () {
    const text = yield* request(
      http,
      FETCH_URL,
      key,
      { url },
      timeoutSeconds,
      fetchLimiter,
      MAX_FETCH_BYTES,
      options.userAgent ?? DEFAULT_USER_AGENT,
    )
    const parsed = yield* Effect.try(() => JSON.parse(text))
    const decoded = yield* Schema.decodeUnknownEffect(FetchResponse)(parsed)
    if (decoded.content.trim().length === 0)
      return yield* Effect.fail(new Error("DeepSeek fetch returned empty content"))
    return { title: decoded.title || undefined, content: decoded.content }
  })

export const fetchPage = (
  ctx: Context,
  http: HttpClient.HttpClient,
  url: string,
  timeoutSeconds = FETCH_TIMEOUT_SECONDS,
): Effect.Effect<{ readonly title?: string; readonly content: string }, unknown> =>
  Effect.gen(function* () {
    const resolved = yield* credential(ctx)
    if (!resolved) return yield* Effect.fail(new Error("DeepSeek API key is not configured"))
    return yield* fetchWithKey(http, resolved.key, url, timeoutSeconds, { userAgent: App.useragent(ctx.app) })
  })
