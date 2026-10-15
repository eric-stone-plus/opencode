export * as ForkGuardPlugin from "./guard.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Cause, Effect, Duration } from "effect"

/**
 * Fail-closed permission guard (borrow C21, reduced to what a fork plugin can actually enforce).
 *
 * The evaluation order is: configured rules (agent, then session) short-circuit a hard deny, saved
 * approvals merge in, and then the plugin hook chain runs in registration order over one shared event.
 * Every fork hook so far tightens by convention — nothing enforces it. Two failures are therefore
 * possible from outside this repository: a runtime-loaded JavaScript plugin (project plugins are not
 * type-checked) can assign a value that is not one of the three declared effects, and a hook that
 * derives its answer from session state can defect or hang, which aborts the evaluation with an opaque
 * error instead of a decision the user can read.
 *
 * This guard is the boundary check, registered after the fork's own hooks in `plugin/fork/index.ts`:
 *
 * - Effect integrity: anything other than `allow`, `ask`, or `deny` becomes `deny`. `Permission.ask`
 *   hands its caller the effect value verbatim, so a value the type system never saw is a real path.
 * - Derivation safety: the guard re-reads the session the request belongs to under a timeout, and a
 *   defect or a timeout denies with a message instead of surfacing as an internal error. Interruption
 *   is not caught: it must keep propagating.
 * - Monotonic tightening: the guard never raises an effect, and an existing `deny` keeps its message
 *   so the attribution another hook wrote (for example "denied by parent session") survives.
 */

/** Long enough for a session read, short enough that a wedged store cannot stall a tool call. */
export const DERIVE_TIMEOUT = Duration.seconds(5)

export type Decision = { readonly effect: "allow" | "ask" | "deny"; readonly message?: string }

/**
 * Pure decision: `failure` is set when the derivation could not run (defect or timeout), and an
 * unknown `effect` is a value the type system never produced. Both deny; everything else is returned
 * unchanged so the guard cannot loosen a decision.
 */
export function guardDecision(effect: string, message: string | undefined, failure: string | undefined): Decision {
  if (failure !== undefined) return { effect: "deny", message: `permission guard: ${failure}` }
  if (effect !== "allow" && effect !== "ask" && effect !== "deny")
    return { effect: "deny", message: `permission guard: unknown effect ${JSON.stringify(effect)}` }
  return message === undefined ? { effect } : { effect, message }
}

/**
 * Runs a fork derivation fail-closed: a defect (other than an interruption) or a timeout becomes a
 * failure string the caller can hand to `guardDecision`. Shared so later fork hooks do not each
 * reinvent the catch and the timeout. Typed failures are converted to defects by the caller with
 * `Effect.orDie`: a derivation that cannot read what it needs has no opinion, and "no opinion" is
 * reported as a failure rather than silently treated as a pass.
 */
export const derive = <A, R>(effect: Effect.Effect<A, never, R>): Effect.Effect<string | undefined, never, R> =>
  effect.pipe(
    Effect.as<string | undefined>(undefined),
    Effect.timeoutOrElse({ duration: DERIVE_TIMEOUT, orElse: () => Effect.succeed("derivation timed out") }),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.succeed(`derivation failed: ${Cause.pretty(cause).split("\n")[0] ?? "unknown cause"}`),
    ),
  )

export const Plugin = define({
  id: "fork.permission-guard",
  effect: Effect.fn("ForkPermissionGuardPlugin")(function* (ctx) {
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        // The session read is the derivation: the fork's own hooks (child authority, write scope)
        // read the same store, so an unreachable or wedged session is exactly the failure class this
        // guard turns into a readable deny. A missing session is a typed failure here and a defect
        // there, so both are collapsed before `derive` sees them.
        const failure = yield* derive(ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie))
        const decision = guardDecision(event.effect, event.message, failure)
        event.effect = decision.effect
        // Never erase a message another hook wrote: an existing deny keeps its attribution.
        if (decision.message !== undefined) event.message = decision.message
      }),
    )
  }),
})
