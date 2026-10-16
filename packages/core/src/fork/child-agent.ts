export * as ChildAgent from "./child-agent.js"

import { Effect, LayerMap, Option, Schema } from "effect"
import { Agent } from "../agent.js"
import type { Instance } from "../instance.js"
import { Location } from "../location.js"
import { awaitActivation } from "../plugin/service.js"
import { SessionSchema } from "../session/schema.js"

/**
 * A primary-mode agent owns top-level framing: its standing card, and for `goal` the goal
 * document. A session created with a parentID is a subagent session, so letting one resolve to a
 * primary agent is a mismatch (docs/adr/0011). The operator's call (2026-10-16, option A): refuse
 * the assignment with a message the CLI and API surface verbatim, never rewrite the agent silently.
 */
export class ChildAgentError extends Schema.TaggedError<ChildAgentError>()("Session.ChildAgentError", {
  sessionID: SessionSchema.ID,
  agent: Agent.ID,
}) {
  override get message() {
    return `Agent "${this.agent}" is a primary agent and cannot run in a child session; use a subagent-mode agent instead`
  }
}

type LocationMap = LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error>

/**
 * Refuse a primary-mode agent on a session with a parentID. The three assignment seams share this
 * (create, switchAgent, transcript import), and the request build (`SessionContext.select`) refuses
 * an omitted agent the same way: creation cannot resolve one without booting the location's service
 * graph, which session creation deliberately avoids. The resolution is deliberately tolerant:
 * `locations` is absent in contexts that never acquire location services (session-owned handles pin
 * exactly that), and a harness that replaces the location graph without an Agent service skips the
 * check instead of failing session creation; an unknown agent id keeps its existing late failure.
 */
export const assertAllowed = Effect.fn("ChildAgent.assertAllowed")(function* (input: {
  sessionID: SessionSchema.ID
  location: Location.Ref
  agent: Agent.ID | undefined
  locations: LocationMap | undefined
}) {
  if (input.locations === undefined) return
  const services = input.locations.get(input.location)
  const resolve = Effect.gen(function* () {
    const agents = yield* Effect.serviceOption(Agent.Service)
    if (Option.isNone(agents)) return undefined
    return yield* agents.value.select(input.agent)
  }).pipe(
    Effect.provide(services),
    // Tolerant by design: a replaced harness without an Agent service, or a location graph that
    // cannot build (Instance.Error), leaves the modes unresolvable; skip instead of failing the
    // assignment. Defects still surface.
    Effect.orElseSucceed(() => undefined),
  )

  let selection = yield* resolve
  if (selection?.info === undefined) {
    // A location that has not finished plugin activation resolves nothing, which would let the
    // first child create after a boot slip a primary profile through (measured against the real
    // server: the first create was accepted, the second refused). Wait for activation and resolve
    // once more; the wait is a no-op once the latch is open, and a failed activation keeps the
    // tolerant skip above.
    yield* awaitActivation.pipe(Effect.provide(services), Effect.orElseSucceed(() => undefined))
    selection = yield* resolve
  }
  if (selection?.info?.mode !== "primary") return
  return yield* new ChildAgentError({ sessionID: input.sessionID, agent: selection.id })
})
