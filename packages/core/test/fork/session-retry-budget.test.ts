import { describe, expect } from "bun:test"
import {
  AIError,
  InvalidRequestError,
  ProviderInternalError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
} from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { PluginHooks } from "@opencode/core/plugin/hooks"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { ForkRetryBudget } from "@opencode/core/session/fork/retry-budget"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"

const internal = new AIError({ reason: new ProviderInternalError({ message: "overloaded" }) })
const reset = new AIError({
  reason: new TransportError({
    message: "connection reset",
    transport: "http",
    operation: "request",
    code: "ECONNRESET",
  }),
})
const unknown = new AIError({ reason: new UnknownProviderError({ message: "something odd" }) })
const rejected = new AIError({ reason: new InvalidRequestError({ message: "bad request" }) })
const limited = (retryAfterMs: number) =>
  new AIError({ reason: new RateLimitError({ message: "slow down", retryAfterMs }) })

type RetryEvent = PluginHooks.Domains["session"]["retry"]

const input = (cause: AIError, hook: (event: RetryEvent) => void = () => {}, agent = Agent.ID.make("auto")) => ({
  cause,
  error: toSessionError(cause),
  agent,
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: (event: RetryEvent) => Effect.sync(() => hook(event)),
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Fails the same way until the policy gives up, spending each granted delay on the test clock.
const exhaust = (cause: AIError, limit = 100, agent = Agent.ID.make("auto")) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_budget"))
    const delays: number[] = []
    for (let i = 0; i < limit; i++) {
      const decision = yield* policy(input(cause, () => {}, agent))
      if (!decision.retry) return delays
      delays.push(decision.delay)
      yield* TestClock.adjust(decision.delay)
    }
    return delays
  })

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)

describe("ForkRetryBudget", () => {
  it.effect("retries provider failures past the default allowance until the 30 minute budget is spent", () =>
    Effect.gen(function* () {
      const delays = yield* exhaust(internal)
      expect(delays.length).toBeGreaterThan(10)
      expect(sum(delays)).toBeLessThanOrEqual(ForkRetryBudget.BUDGET)
      // The next gap would not have fit: stopping early leaves less than one maximum gap unspent.
      expect(ForkRetryBudget.BUDGET - sum(delays)).toBeLessThan(ForkRetryBudget.MAX_GAP + Duration.toMillis("1 second"))
    }),
  )

  it.effect("backs off exponentially from two seconds with additive jitter and caps each gap at five minutes", () =>
    Effect.gen(function* () {
      const delays = yield* exhaust(reset)
      delays.slice(0, 8).forEach((delay, index) => {
        const base = 2_000 * 2 ** index
        expect(delay).toBeGreaterThanOrEqual(base)
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.25))
      })
      expect(delays.length).toBeGreaterThan(8)
      delays.forEach((delay) => expect(delay).toBeLessThanOrEqual(ForkRetryBudget.MAX_GAP))
      expect(delays.at(-1)).toBe(ForkRetryBudget.MAX_GAP)
    }),
  )

  it.effect("treats a provider-requested delay as a floor, bounded by the maximum gap", () =>
    Effect.gen(function* () {
      const requested = yield* exhaust(limited(90_000), 1)
      expect(requested[0]).toBeGreaterThanOrEqual(90_000)
      const bounded = yield* exhaust(limited(Duration.toMillis("2 hours")), 1)
      expect(bounded[0]).toBe(ForkRetryBudget.MAX_GAP)
    }),
  )

  it.effect("keeps the short allowance for unrecognized failures", () =>
    Effect.gen(function* () {
      const delays = yield* exhaust(unknown)
      expect(delays).toHaveLength(10)
      // The short allowance never waits longer than ten seconds between attempts.
      expect(Math.max(...delays)).toBeLessThanOrEqual(12_100)
    }),
  )

  it.effect("keeps the upstream allowance for interactive agents", () =>
    Effect.gen(function* () {
      const delays = yield* exhaust(internal, 100, Agent.ID.make("build"))
      expect(delays).toHaveLength(10)
      expect(Math.max(...delays)).toBeLessThanOrEqual(12_100)
    }),
  )

  it.effect("never retries a deterministic rejection", () =>
    Effect.gen(function* () {
      expect(yield* exhaust(rejected)).toEqual([])
    }),
  )

  it.effect("still caps transport timeouts at three retries inside the budget", () =>
    Effect.gen(function* () {
      const timeout = new AIError({
        reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
      })
      expect(yield* exhaust(timeout)).toHaveLength(3)
    }),
  )

  it.effect("lets the retry hook replace the delay or refuse the retry", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_budget_hook"))
      const replaced = yield* policy(
        input(internal, (event) => {
          event.decision = { retry: true, delay: 7 }
        }),
      )
      expect(replaced).toMatchObject({ retry: true, delay: 7 })
      const refused = yield* policy(
        input(internal, (event) => {
          event.decision = { retry: false }
        }),
      )
      expect(refused).toEqual({ retry: false })
    }),
  )
})

describe("ForkRetryBudget.transient", () => {
  it.effect("covers failures that clear on their own and nothing else", () =>
    Effect.gen(function* () {
      expect(ForkRetryBudget.transient(internal)).toBe(true)
      expect(ForkRetryBudget.transient(reset)).toBe(true)
      expect(ForkRetryBudget.transient(limited(1_000))).toBe(true)
      expect(ForkRetryBudget.transient(unknown)).toBe(false)
      expect(ForkRetryBudget.transient(rejected)).toBe(false)
    }),
  )
})

describe("ForkRetryBudget.unattended", () => {
  it.effect("covers the walk-away profiles and nothing else", () =>
    Effect.gen(function* () {
      expect(ForkRetryBudget.unattended(Agent.ID.make("auto"))).toBe(true)
      expect(ForkRetryBudget.unattended(Agent.ID.make("goal"))).toBe(true)
      expect(ForkRetryBudget.unattended(Agent.ID.make("build"))).toBe(false)
      expect(ForkRetryBudget.unattended(Agent.ID.make("plan"))).toBe(false)
    }),
  )
})
