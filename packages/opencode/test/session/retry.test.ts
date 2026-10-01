import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Effect, Fiber, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, 0))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("adds jitter to exponential delays", () => {
    const error = apiError()
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
    expect(SessionRetry.delay(1, error, 1)).toBe(2500)
    expect(SessionRetry.delay(4, error, 1)).toBe(20000)
    expect(SessionRetry.delay(5, error, 1)).toBe(30000)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores negative retry hints", () => {
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": "-1" }), 0)).toBe(2000)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "-1" }), 0)).toBe(2000)
  })

  test("ignores non-finite retry hints", () => {
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": "Infinity" }), 0)).toBe(2000)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "Infinity" }), 0)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps backoff at 30 seconds when headers carry no retry hint", () => {
    const error = apiError({ "content-type": "application/json", "x-request-id": "abc" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
    expect(SessionRetry.delay(10, error, 1)).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
    expect(SessionRetry.delay(40, error, 1)).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
    expect(SessionRetry.delay(40, error, 1, 60_000)).toBe(60_000)
    // an explicit hint still wins over the cap
    expect(SessionRetry.delay(40, apiError({ "retry-after": "120" }), 1)).toBe(120_000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  it.instance("policy stops after five retries", () =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const error = apiError({ "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            Effect.sync(() => {
              attempts.push(info.attempt)
            }),
        }),
      )

      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES + 1 }), () =>
        Effect.ignore(step(error)),
      )

      expect(attempts).toStrictEqual([1, 2, 3, 4, 5])
    }),
  )

  // Drives the real schedule under TestClock and records each scheduled wait.
  const runBudget = (budget: Parameters<typeof SessionRetry.policy>[0]["budget"], error = apiError()) =>
    Effect.gen(function* () {
      const waits: number[] = []
      let last = 0
      const fiber = yield* Effect.fail(error).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "test",
            budget,
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            set: (info) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                waits.push(info.next - now)
                last = now
              }),
          }),
        ),
        Effect.exit,
        Effect.forkChild,
      )
      yield* TestClock.adjust("10 hours")
      yield* Fiber.join(fiber)
      return { waits, last }
    })

  it.effect("keeps the default of five retries capped at 30 seconds", () =>
    Effect.gen(function* () {
      const { waits } = yield* runBudget(undefined)
      expect(waits).toHaveLength(5)
      expect(Math.max(...waits)).toBeLessThanOrEqual(30_000)
    }),
  )

  it.effect("retries until a 30 minute wall-clock budget runs out, 60 seconds apart at most", () =>
    Effect.gen(function* () {
      const { waits, last } = yield* runBudget({ max_elapsed_ms: 30 * 60_000, max_delay_ms: 60_000 })
      const total = waits.reduce((sum, wait) => sum + wait, 0)
      // Unlimited attempts under a time budget, never waiting longer than the cap.
      expect(waits.length).toBeGreaterThan(5)
      expect(Math.max(...waits)).toBeLessThanOrEqual(60_000)
      expect(waits.at(-1)).toBe(60_000)
      // The last retry fires inside the budget and the next one would overrun it.
      expect(total).toBeLessThanOrEqual(30 * 60_000)
      expect(total + 60_000).toBeGreaterThan(30 * 60_000)
      expect(last).toBeLessThan(30 * 60_000)
    }),
  )

  it.effect("applies max_attempts together with the wall-clock budget", () =>
    Effect.gen(function* () {
      const { waits } = yield* runBudget({ max_attempts: 3, max_elapsed_ms: 30 * 60_000 })
      expect(waits).toHaveLength(3)
    }),
  )

  it.effect("caps waits from retry headers at max_delay_ms", () =>
    Effect.gen(function* () {
      // A header-bearing error with no retry-after uses exponential backoff.
      const { waits } = yield* runBudget({ max_attempts: 8, max_delay_ms: 60_000 }, apiError({}))
      expect(Math.max(...waits)).toBe(60_000)
    }),
  )
})

describe("session.retry transient budget", () => {
  const network = () =>
    Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET" },
      }).toObject(),
    )
  const status = (statusCode: number, headers?: Record<string, string>) =>
    Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "busy", statusCode, isRetryable: true, responseHeaders: headers }).toObject(),
    )

  const run = (error: SessionV1.APIError, budget?: Parameters<typeof SessionRetry.policy>[0]["budget"]) =>
    Effect.gen(function* () {
      const waits: number[] = []
      const fiber = yield* Effect.fail(error).pipe(
        Effect.retry(
          SessionRetry.policy({
            provider: "test",
            budget,
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            set: (info) =>
              Effect.gen(function* () {
                waits.push(info.next - (yield* Clock.currentTimeMillis))
              }),
          }),
        ),
        Effect.exit,
        Effect.forkChild,
      )
      yield* TestClock.adjust("10 hours")
      yield* Fiber.join(fiber)
      return waits
    })

  test("classifies network, rate limit and server errors as transient", () => {
    expect(SessionRetry.transient(network())).toBe(true)
    expect(SessionRetry.transient(status(429))).toBe(true)
    expect(SessionRetry.transient(status(503))).toBe(true)
    expect(SessionRetry.transient(wrap("fetch failed"))).toBe(true)
    expect(SessionRetry.transient(wrap("Unable to connect. Is the computer able to access the url?"))).toBe(true)
    expect(SessionRetry.transient(apiError())).toBe(false)
    expect(SessionRetry.transient(status(400))).toBe(false)
  })

  it.effect("retries network errors for 30 minutes, at most 5 minutes apart", () =>
    Effect.gen(function* () {
      const waits = yield* run(network())
      const total = waits.reduce((sum, wait) => sum + wait, 0)
      expect(waits.length).toBeGreaterThan(SessionRetry.RETRY_MAX_RETRIES)
      expect(Math.max(...waits)).toBe(SessionRetry.RETRY_TRANSIENT_MAX_DELAY)
      expect(total).toBeLessThanOrEqual(SessionRetry.RETRY_TRANSIENT_BUDGET)
      expect(total + SessionRetry.RETRY_TRANSIENT_MAX_DELAY).toBeGreaterThan(SessionRetry.RETRY_TRANSIENT_BUDGET)
    }),
  )

  it.effect("caps a long retry-after at the max delay instead of sleeping past the budget", () =>
    Effect.gen(function* () {
      const waits = yield* run(status(429, { "retry-after": "86400" }))
      expect(waits.length).toBeGreaterThan(1)
      expect(waits.every((wait) => wait === SessionRetry.RETRY_TRANSIENT_MAX_DELAY)).toBe(true)
      const capped = yield* run(status(429, { "retry-after": "86400" }), { max_delay_ms: 60_000, max_attempts: 2 })
      expect(capped).toEqual([60_000, 60_000])
    }),
  )

  it.effect("keeps configured retry limits for transient errors", () =>
    Effect.gen(function* () {
      expect(yield* run(network(), { max_attempts: 2 })).toHaveLength(2)
      const waits = yield* run(network(), { max_elapsed_ms: 60_000 })
      expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(60_000)
    }),
  )

  it.effect("keeps the five-attempt default for other retryable errors", () =>
    Effect.gen(function* () {
      expect(yield* run(apiError())).toHaveLength(SessionRetry.RETRY_MAX_RETRIES)
    }),
  )

  it.effect("does not retry non-transient errors", () =>
    Effect.gen(function* () {
      const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
        new SessionV1.APIError({ message: "invalid request", statusCode: 400, isRetryable: false }).toObject(),
      )
      expect(yield* run(error)).toHaveLength(0)
    }),
  )
})

describe("session.retry.retryable", () => {
  test("retries serialized too_many_requests messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("retries serialized overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("retries serialized rate_limit messages", () => {
    const message = JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } })
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test.each([
    "Internal server error",
    "internal error",
    "server-error",
    "Provider returned error",
    "provider-returned-error",
    "terminated",
    "fetch failed",
    "network error",
    "network-error",
    "network_error",
    "connection refused",
    "connect ECONNREFUSED",
    "request ETIMEDOUT",
    "failed to fetch",
    "EAI_AGAIN",
    "response timed out",
    "Please retry your request",
    "try your request again",
    "Please try again in a few minutes",
    "The model is currently at capacity due to high demand",
    "The service is temporarily at capacity",
    "upstream returned status 524",
  ])("retries matching API error text: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("retries hyphenated service-unavailable errors", () => {
    expect(SessionRetry.retryable(wrap("service-unavailable"), retryProvider)).toEqual({
      message: "Provider is overloaded",
    })
  })

  test("matches retryable API response bodies", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "upstream connection refused" } }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Request failed" })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test.each([
    "Bad Request: request id 7f3a4290-5003-4cbb-8a12-ab5240c19524",
    "Invalid parameter: max_tokens must be <= 4096, got 5000",
    "Model not found (trace 429b81c0)",
  ])("does not retry status-code digits embedded in other tokens: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toBeUndefined()
  })

  test.each([
    "HTTP 503",
    "status code: 502",
    "503 Service Temporarily Down",
    "<500> upstream",
    "Bad Gateway",
    "error: 429",
  ])("retries standalone status codes: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("does not retry a 400 whose response body contains status-like digits in ids", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad Request",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({
          request_id: "e5024a0b-5291-9500-b429-3e8c5240a503",
          error: { code: "invalid" },
        }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("never retries an overflow that arrives as a plain API error", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error: prompt is too long",
        isRetryable: true,
        statusCode: 500,
        responseBody: '{"error":{"message":"prompt is too long","request_id":"503"}}',
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("Zhipu 1261 and DashScope input-length errors become non-retryable overflow", () => {
    const cases = [
      new APICallError({
        message: "Bad Request",
        url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "1261", message: "Prompt exceeds max length" } }),
        isRetryable: false,
      }),
      new APICallError({
        message: "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]",
        url: "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({
          request_id: "9c0b5003-4290-9524-a502-4f0e1c2b8500",
          error: { message: "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]" },
        }),
        isRetryable: false,
      }),
    ]
    for (const e of cases) {
      const error = MessageV2.fromError(e, { providerID })
      expect(SessionV1.ContextOverflowError.isInstance(error)).toBe(true)
      expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
    }
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
