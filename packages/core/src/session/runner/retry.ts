export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { ForkRetryBudget } from "../fork/retry-budget.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/**
 * Why the policy stopped retrying. The terminal state used to be a bare `{ retry: false }`, which read
 * the same whether a deterministic rejection ended the step or a walk-away budget ran out after half an
 * hour of provider outage - the two cases an operator most needs to tell apart.
 */
export type Exhausted = "budget" | "attempts" | "timeout" | "not-retryable" | "hook"

export interface Refusal {
  readonly retry: false
  readonly exhausted: Exhausted
}

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a step for most of an hour. Cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 3

const isTimeout = (error: AIError) => error.reason._tag === "Transport" && error.reason.code === "Timeout"

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    // Attended requests keep upstream's short, bounded policy. The fork's walk-away budget is layered
    // on top only for the unattended profiles.
    const short = yield* ModelRetry.policy
    const budgeted = yield* Schedule.toStep(ForkRetryBudget.schedule<Input>())
    let attempt = 1
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        // The budget is for sessions the user walks away from; an attended request must fail fast and bounded.
        const useBudget = ForkRetryBudget.transient(input.cause) && ForkRetryBudget.unattended(input.agent)
        if (isTimeout(input.cause)) timeouts++
        let next: { readonly attempt: number; readonly delay: number; readonly retry: boolean } | undefined
        let exhausted: Exhausted | undefined
        if (useBudget) {
          const now = yield* Clock.currentTimeMillis
          const scheduled = yield* budgeted(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
          if (!scheduled) {
            exhausted = "budget"
          } else {
            const [, duration] = scheduled
            attempt++
            // The budget decides how long to keep trying, not whether the provider said the failure is
            // deterministic: a transient tag can still carry `x-should-retry: false` or a rejected write.
            next = { attempt, delay: Math.ceil(Duration.toMillis(duration)), retry: input.retry }
          }
        } else {
          const decided = yield* short(input)
          if (!decided) {
            exhausted = "attempts"
          } else {
            next = decided
            attempt = decided.attempt
          }
        }
        if (!next) {
          const reason = exhausted ?? "attempts"
          yield* Effect.logInfo("session.retry.exhausted", { sessionID, exhausted: reason, attempt })
          return { retry: false as const, exhausted: reason }
        }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision:
            next.retry && (!isTimeout(input.cause) || timeouts <= MAX_TIMEOUT_RETRIES)
              ? { retry: true, delay: next.delay }
              : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) {
          // A deterministic rejection is the ordinary path and stays quiet; the other three are the ones
          // worth a log line, because each means the step gave up on a failure that could have cleared.
          const exhausted: Exhausted = !input.retry
            ? "not-retryable"
            : timeouts > MAX_TIMEOUT_RETRIES
              ? "timeout"
              : "hook"
          if (exhausted !== "not-retryable")
            yield* Effect.logInfo("session.retry.exhausted", { sessionID, exhausted, attempt })
          return { retry: false as const, exhausted }
        }
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
