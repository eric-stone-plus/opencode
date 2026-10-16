// The child-agent guard (docs/adr/0011): a session with a parentID must never resolve to a
// primary-mode agent. These pin all three assignment seams — Session.create, Session.switchAgent,
// and the transcript import — plus the legitimate paths they must not break (roots, subagent-mode
// agents, no-op switches, unknown ids).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Agent } from "@opencode/core/agent"
import { ChildAgent } from "@opencode/core/fork/child-agent"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  SessionTransfer.node,
])
const replacements = [
  Global.node.replace(tempGlobalLayer),
  // This suite exercises the guard, not discovery; the closed trust default is pinned by
  // test/fork/project-trust*.
  ProjectTrust.node.replace(ProjectTrust.layer({ all: true, roots: [] })),
  offlineModels,
] satisfies LayerNode.Replacements
const it = testEffect(AppNodeBuilder.build(nodes, replacements))

/** Registers the two primary profiles and one subagent profile the guard reasons about. */
const withAgents = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(Agent.ID.make("auto"), (agent) => {
          agent.mode = "primary"
        })
        editor.update(Agent.ID.make("goal"), (agent) => {
          agent.mode = "primary"
        })
        editor.update(Agent.ID.make("general"), (agent) => {
          agent.mode = "subagent"
        })
        editor.default(Agent.ID.make("auto"))
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

/** Fails the test unless the effect was refused by the child-agent guard. */
const refused = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.flatMap((error) =>
      error._tag === "Session.ChildAgentError"
        ? Effect.succeed(error as Extract<E, ChildAgent.ChildAgentError>)
        : Effect.die(`expected the child-agent guard, got ${error._tag}`),
    ),
  )

describe("child agent guard", () => {
  it.live("keeps roots on primary agents and refuses them on children", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tmp = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* withAgents(location)

      const parent = yield* sessions.create({ location, agent: Agent.ID.make("auto") })
      expect(String(parent.agent)).toBe("auto")

      const error = yield* refused(sessions.create({ parentID: parent.id, agent: Agent.ID.make("goal") }))
      expect(error._tag).toBe("Session.ChildAgentError")
      expect(String(error.agent)).toBe("goal")
      expect(error.message).toContain('"goal"')
      expect(error.message).toContain("child session")

      // The subagent tool's own flow (an explicit subagent-mode agent) is untouched.
      const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("general") })
      expect(String(child.agent)).toBe("general")
      expect(child.parentID).toBe(parent.id)
    }),
  )

  it.live("refuses the omitted agent falling back to the default primary agent at the request build", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const tmp = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* withAgents(location)
      const parent = yield* sessions.create({ location, agent: Agent.ID.make("auto") })

      // Creation must not resolve the default: that would boot the location's service graph, which
      // session creation deliberately avoids (test/session-remove.test.ts pins the laziness). The
      // omitted agent therefore resolves - and is refused - where the runner would resolve it.
      const child = yield* sessions.create({ parentID: parent.id })
      expect(child.agent).toBeUndefined()

      const context = yield* SessionContext.Service.pipe(Effect.provide(locations.get(location)))
      const error = yield* refused(context.select(child.id))
      expect(error._tag).toBe("Session.ChildAgentError")
      expect(String(error.agent)).toBe("auto")
    }),
  )

  it.live("guards switchAgent on children only, leaving no-ops and unknown ids alone", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tmp = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* withAgents(location)
      const parent = yield* sessions.create({ location, agent: Agent.ID.make("auto") })
      const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("general") })

      yield* sessions.switchAgent({ sessionID: parent.id, agent: Agent.ID.make("goal") })
      expect(String((yield* sessions.get(parent.id)).agent)).toBe("goal")

      const error = yield* refused(sessions.switchAgent({ sessionID: child.id, agent: Agent.ID.make("auto") }))
      expect(error._tag).toBe("Session.ChildAgentError")
      expect(String((yield* sessions.get(child.id)).agent)).toBe("general")

      // Re-asserting the current agent is not an assignment, so rows created before the guard
      // stay switchable, and an unknown id keeps its existing late failure.
      yield* sessions.switchAgent({ sessionID: child.id, agent: Agent.ID.make("general") })
      yield* sessions.switchAgent({ sessionID: child.id, agent: Agent.ID.make("no-such-agent") })
      expect(String((yield* sessions.get(child.id)).agent)).toBe("no-such-agent")
    }),
  )

  it.live("refuses a primary agent on an imported child transcript", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const tmp = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      yield* withAgents(location)
      const parent = yield* sessions.create({ location, agent: Agent.ID.make("auto") })
      const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("general") })
      const data = yield* transfer.export({ sessionID: child.id })

      const error = yield* refused(
        transfer.import({
          data: { ...data, info: { ...data.info, id: Session.ID.create(), agent: Agent.ID.make("goal") } },
          location,
        }),
      )
      expect(error._tag).toBe("Session.ChildAgentError")

      const imported = yield* transfer.import({
        data: { ...data, info: { ...data.info, id: Session.ID.create(), agent: Agent.ID.make("general") } },
        location,
      })
      expect(String(imported.agent)).toBe("general")
      expect(imported.parentID).toBe(parent.id)
    }),
  )
})
