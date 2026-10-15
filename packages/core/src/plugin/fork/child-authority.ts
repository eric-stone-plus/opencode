export * as ForkChildAuthorityPlugin from "./child-authority.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { Session } from "@opencode/schema/session"
import { Agent } from "../../agent.js"
import { Permission } from "../../permission.js"
import { Wildcard } from "../../util/wildcard.js"

// Spawn boundary as an intersection (borrow C32). Rule sets are order-sensitive concatenations where
// the last match wins, so at the spawn boundary a child session can exceed the very parent that spawned
// it. This plugin closes that gap from the tightening side only - core short-circuits hard denies
// before the hook fires - and enforces what codewhale computes up front as
// ChildAuthority = intersect(parent authority, child profile) (crates/tui/src/worker_profile.rs:492-517):
// a child may never do what an ancestor forbids, and an ancestor that demands approval demands it for
// the child too. An ancestor that is silent about a request constrains nothing, so the default-ask
// fallthrough of `Permission.evaluate` is deliberately not inherited.
const MAX_CHAIN = 16

// Mirrors core permission.ts: an agent that cannot be resolved denies everything. Fail-closed, and a
// parent that cannot act drags its spawn chain with it.
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export type Ancestor = { id: Session.ID; rules: Permission.Ruleset }

export type Inherited = { effect: "allow" | "ask" | "deny"; reason?: string }

export function inheritDecision(
  ancestors: readonly Ancestor[],
  action: string,
  resources: readonly string[],
): Inherited {
  let result: Inherited = { effect: "allow" }
  for (const ancestor of ancestors) {
    for (const resource of resources) {
      // Same matching as `Permission.evaluate`, minus its ask fallthrough: whether the ancestor has
      // an opinion at all is exactly the question here.
      const matched = ancestor.rules.findLast(
        (rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource),
      )
      if (matched === undefined || matched.effect === "allow") continue
      if (matched.effect === "deny")
        return { effect: "deny", reason: `denied by parent session ${ancestor.id}: ${action} ${resource}` }
      if (result.effect === "allow")
        result = { effect: "ask", reason: `approval required by parent session ${ancestor.id}: ${action} ${resource}` }
    }
  }
  return result
}

export const Plugin = define({
  id: "fork.child-authority",
  effect: Effect.fn("ForkChildAuthorityPlugin")(function* (ctx) {
    const lookup = (sessionID: Session.ID) => ctx.session.get({ sessionID }).pipe(Effect.orElseSucceed(() => undefined))
    const agents = yield* Agent.Service
    const rulesOf = (session: Session.Info) =>
      Effect.gen(function* () {
        // Same shape as core `configured()`: agent rules first, session rules after, last match wins.
        // `resolve` mirrors core exactly - an absent agent becomes the selected default (so sessions
        // created without one, e.g. via ACP or the HTTP API, stay usable) and a named-but-missing
        // agent stays missing, which fails closed below.
        const agent = yield* agents.resolve(session.agent)
        return Permission.merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
      })
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        // The chain follows parentID and fork lineage alike: a fork keeps the source's authority
        // (session affinity treats the same field as lineage), so forking cannot escape the
        // intersection. A dangling link ends the walk - imported sessions may reference parents that
        // were never imported - and a chain cut at MAX_CHAIN is logged instead of silently believed.
        const ancestors: Ancestor[] = []
        let current = yield* lookup(event.sessionID)
        let link = current && (current.parentID ?? current.fork?.sessionID)
        let truncated = false
        while (current !== undefined && link !== undefined) {
          if (ancestors.length >= MAX_CHAIN) {
            truncated = true
            break
          }
          const parent = yield* lookup(link)
          if (parent === undefined) break
          ancestors.push({ id: parent.id, rules: yield* rulesOf(parent) })
          current = parent
          link = current.parentID ?? current.fork?.sessionID
        }
        if (truncated)
          yield* Effect.logWarning("fork.child-authority: ancestor chain truncated", {
            sessionID: event.sessionID,
            depth: MAX_CHAIN,
          })
        const decision = inheritDecision(ancestors, event.action, event.resources)
        if (decision.effect === "allow") return
        // Tightening only: the event is `allow` or `ask` here (hard denies return before the hook),
        // and both may move toward `deny`, never away from it.
        if (decision.effect === "deny" || event.effect === "allow") {
          event.effect = decision.effect
          event.message = decision.reason
        }
      }),
    )
  }),
})
