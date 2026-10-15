export * as ForkEnvelopePlugin from "./envelope.js"

import { SystemPart } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Permission } from "../../permission.js"
import { PermissionSaved } from "../../permission/saved.js"
import { SessionSchema } from "../../session/schema.js"

/**
 * Capability envelope audit (borrow C29, reduced to the informational half a fork plugin can own).
 *
 * The report's card was a startup approval gate: show the user what this session may do and let them
 * accept it. A plugin has no startup UI, so this keeps the part that is still real - the session's
 * effective permission envelope is computed once, written to the log, and handed to the model as a
 * system part on the session's first request.
 *
 * What the summary is, precisely: core evaluates configured rules first (agent rules, then session
 * rules, last match wins) and a hard deny there returns before any plugin hook runs; only then do
 * saved approvals merge in and the hook chain tighten. So the printed verdict per action is an upper
 * bound - the real decision can be stricter, never looser. The card says so in as many words, because
 * a summary that reads like a promise is worse than no summary.
 *
 * The enforcement half (a configurable high-risk deny set, default empty) stays an owner decision: it
 * changes what the seat refuses to do, and it needs a config key this fork does not have yet.
 */

/** Actions the audit reports: the ones a seat's trust boundary is actually made of. */
export const AUDIT_ACTIONS = ["edit", "shell", "read", "external_directory", "webfetch", "subagent", "question"] as const

/** Core's fallback for a session whose agent cannot be resolved: nothing is permitted. */
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export function envelopeSummary(input: {
  readonly agent: string
  readonly configured: Permission.Ruleset
  readonly saved: number
}): string {
  const verdicts = AUDIT_ACTIONS.map(
    (action) => `${action}=${Permission.evaluate(action, "*", input.configured).effect}`,
  ).join(" ")
  return [
    `Permission envelope for agent ${input.agent}: ${input.configured.length} configured rule(s), ${input.saved} saved approval(s).`,
    `Upper bound before plugin tightening: ${verdicts}.`,
  ].join(" ")
}

export const Plugin = define({
  id: "fork.permission-envelope",
  effect: Effect.fn("ForkPermissionEnvelopePlugin")(function* (ctx) {
    const saved = yield* PermissionSaved.Service
    // Process-local on purpose: the card belongs to the first request this process assembles for the
    // session. A restart re-reports, which is the honest answer - the envelope may have changed.
    const reported = new Set<SessionSchema.ID>()

    /** A failing audit must not fail the model request. */
    const isolate = <A>(label: string, fallback: A) =>
      Effect.catchCause((cause) => Effect.logWarning(label, { cause }).pipe(Effect.as(fallback)))

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (reported.has(event.sessionID)) return
        reported.add(event.sessionID)
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => undefined))
        const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.orElseSucceed(() => undefined))
        const configured = Permission.merge(
          agent?.data.permissions ?? missingAgentPermissions,
          session?.permissions ?? [],
        )
        const approvals = yield* saved.list({ projectID: ctx.location.project.id })
        yield* Effect.logInfo("fork.permission-envelope", {
          sessionID: event.sessionID,
          agent: event.agent,
          configured,
          saved: approvals.length,
        })
        event.system.push(SystemPart.make(envelopeSummary({ agent: event.agent, configured, saved: approvals.length })))
      }).pipe(isolate("failed to report the permission envelope", undefined)),
    )
  }),
})
