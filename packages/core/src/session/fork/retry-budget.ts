export * as ForkRetryBudget from "./retry-budget.js"

import type { AIError } from "@opencode/ai"
import { Cause, Duration, Effect, Random, Schedule } from "effect"

/** Wall-clock allowance for one Step's transient failures: a provider outage or a sleeping laptop outlasts 84s. */
export const BUDGET = Duration.toMillis("30 minutes")
/** Longest single wait, so a recovered provider is noticed within five minutes. */
export const MAX_GAP = Duration.toMillis("5 minutes")
const INITIAL = Duration.toMillis("2 seconds")
const JITTER = 0.25

/**
 * Failures that clear on their own given time. Unrecognized failures stay on the short allowance because a
 * deterministic rejection that arrives in an unknown shape would otherwise hold a Step for the whole budget.
 */
export const transient = (cause: AIError) =>
  cause.reason._tag === "RateLimit" ||
  cause.reason._tag === "ProviderInternal" ||
  cause.reason._tag === "Transport" ||
  (cause.reason._tag === "InvalidProviderOutput" && cause.reason.classification === "incomplete-stream")

const requested = (cause: AIError) =>
  cause.reason._tag === "RateLimit" || cause.reason._tag === "ProviderInternal" ? cause.reason.retryAfterMs : undefined

/**
 * Exponential backoff from 2s with up to 25% added jitter, capped per gap, that stops once the next wait would
 * pass the budget. A provider-requested delay is a floor, capped like any other gap.
 */
export const schedule = <Input extends { readonly cause: AIError }>() =>
  Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<Input>) =>
      Effect.gen(function* () {
        const random = yield* Random.next
        const backoff = Math.ceil(INITIAL * 2 ** (meta.attempt - 1) * (1 + JITTER * random))
        const wait = Duration.millis(Math.min(Math.max(backoff, requested(meta.input.cause) ?? 0), MAX_GAP))
        if (meta.elapsed + Duration.toMillis(wait) > BUDGET) return yield* Cause.done(wait)
        return [wait, wait] as [Duration.Duration, Duration.Duration]
      }),
    ),
  )
