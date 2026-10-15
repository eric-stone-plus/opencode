// Spawn boundary as an intersection (borrow C32). A child session must never exceed the parent that
// spawned it, no matter what order the rule concatenation puts things in. These tests pin both halves:
// the pure decision (deny and explicit-ask propagate; silence does not) and the hook wiring that applies
// it to live permission evaluations.
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Agent as AgentCore } from "@opencode/core/agent"
import { SessionMessage } from "@opencode/core/session/message"
import { ForkChildAuthorityPlugin, inheritDecision, type Ancestor } from "@opencode/core/plugin/fork/child-authority"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { testEffect } from "../../lib/effect"
import { host } from "../host"

const parent = SessionSchema.ID.make("ses_parent")
const child = SessionSchema.ID.make("ses_child")
const grand = SessionSchema.ID.make("ses_grand")

const denyEdit: Permission.Ruleset = [{ action: "edit", resource: "*", effect: "deny" }]
const askEdit: Permission.Ruleset = [{ action: "edit", resource: "*", effect: "ask" }]
const allowAll: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]

const ancestor = (id: SessionSchema.ID, rules: Permission.Ruleset): Ancestor => ({ id, rules })

describe("inheritDecision", () => {
  test("a denying parent forbids the child", () => {
    expect(inheritDecision([ancestor(parent, denyEdit)], "edit", ["/etc/passwd"])).toEqual({
      effect: "deny",
      reason: `denied by parent session ${parent}: edit /etc/passwd`,
    })
  })

  test("a silent parent constrains nothing", () => {
    // `Permission.evaluate` falls through to ask; inheriting that would prompt on every subagent action.
    expect(inheritDecision([ancestor(parent, [])], "edit", ["/etc/passwd"])).toEqual({ effect: "allow" })
  })

  test("an explicit ask parent downgrades allow to ask but never to allow", () => {
    expect(inheritDecision([ancestor(parent, askEdit)], "edit", ["/etc/passwd"])).toEqual({
      effect: "ask",
      reason: `approval required by parent session ${parent}: edit /etc/passwd`,
    })
  })

  test("deny wins across the chain in both orders", () => {
    const rules: Ancestor[] = [ancestor(child, askEdit), ancestor(parent, denyEdit)]
    expect(inheritDecision(rules, "edit", ["src/a.ts"]).effect).toBe("deny")
    expect(inheritDecision([...rules].reverse(), "edit", ["src/a.ts"]).effect).toBe("deny")
  })

  test("an explicitly allowing parent is not a constraint", () => {
    expect(inheritDecision([ancestor(parent, allowAll)], "edit", ["src/a.ts"])).toEqual({ effect: "allow" })
  })
})

const sessionInfo = (input: {
  id: SessionSchema.ID
  parentID?: SessionSchema.ID
  forkOf?: SessionSchema.ID
  agent?: Agent.ID
  permissions: Permission.Ruleset
}) =>
  SessionSchema.Info.make({
    id: input.id,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/workspace") },
    ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    ...(input.forkOf === undefined
      ? {}
      : {
          fork: {
            sessionID: input.forkOf,
            boundary: { type: "through" as const, messageID: SessionMessage.ID.make("msg_boundary") },
          },
        }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    permissions: input.permissions,
  })

const it = testEffect(Layer.empty)

/** Runs the plugin against stubbed sessions and agents and captures its evaluate hook. */
const run = Effect.fnUntraced(function* (input: {
  sessions: SessionSchema.Info[]
  agents: Record<string, Permission.Ruleset>
  /** Rules of the selected default agent - what core `resolve(undefined)` serves for agent-less sessions. */
  defaultAgent?: Permission.Ruleset
}) {
  let evaluateHook: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  // The plugin resolves ancestor agents through core's Agent.Service (the mirror of `configured()`),
  // so the rules live on a mocked service; the stubbed ctx.agent is no longer consulted at all.
  const agents = Layer.mock(AgentCore.Service, {
    resolve: (id?: string) => {
      const rules = id === undefined ? input.defaultAgent : input.agents[id]
      return Effect.succeed(
        rules === undefined ? undefined : { ...Agent.Info.default(Agent.ID.make(id ?? "build")), permissions: rules },
      )
    },
  })
  yield* ForkChildAuthorityPlugin.Plugin.effect(
    host({
      permission: {
        hook: (name, callback) => {
          if (name === "evaluate") evaluateHook = callback as (event: PermissionEvaluation) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        list: () => Effect.die("unused permission.list"),
        get: () => Effect.die("unused permission.get"),
        reply: () => Effect.die("unused permission.reply"),
        assert: () => Effect.die("unused permission.assert"),
      },
      session: {
        get: (request) => {
          const found = input.sessions.find((session) => session.id === request.sessionID)
          return found === undefined ? Effect.fail(`no session ${request.sessionID}`) : Effect.succeed(found)
        },
      },
    }),
  ).pipe(Effect.provide(agents))
  if (!evaluateHook) return yield* Effect.die("fork.child-authority did not register an evaluate hook")
  return evaluateHook
})

const evaluate = (sessionID: SessionSchema.ID, effect: PermissionEvaluation["effect"] = "allow"): PermissionEvaluation => ({
  sessionID,
  action: "edit",
  resources: ["/etc/passwd"],
  effect,
})

describe("fork child authority: the hook", () => {
  it.effect("denies what the spawning parent forbids", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, agent: Agent.ID.make("build"), permissions: denyEdit }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { build: allowAll, explore: allowAll },
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("deny")
      expect(event.message).toBe(`denied by parent session ${parent}: edit /etc/passwd`)
    }),
  )

  it.effect("demands approval when the parent demands it", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, agent: Agent.ID.make("build"), permissions: askEdit }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { build: allowAll, explore: allowAll },
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("ask")
    }),
  )

  it.effect("walks the whole chain and leaves root sessions alone", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: grand, agent: Agent.ID.make("build"), permissions: denyEdit }),
          sessionInfo({ id: parent, parentID: grand, agent: Agent.ID.make("build"), permissions: [] }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { build: allowAll, explore: allowAll },
      })
      const rooted = evaluate(grand)
      yield* hook(rooted)
      expect(rooted.effect).toBe("allow")
      const nested = evaluate(child)
      yield* hook(nested)
      expect(nested.effect).toBe("deny")
    }),
  )

  it.effect("a silent parent stays silent", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, agent: Agent.ID.make("build"), permissions: [] }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { build: [], explore: allowAll },
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("allow")
    }),
  )

  it.effect("an unresolved parent agent fails closed", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, agent: Agent.ID.make("gone"), permissions: [] }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { explore: allowAll },
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("deny")
    }),
  )

  it.effect("an agent-less parent inherits the default agent's rules", () =>
    Effect.gen(function* () {
      // Sessions created through ACP or the HTTP API carry no agent; core resolves their rules from
      // the selected default agent (`configured()`), and the inheritance has to mirror that.
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, permissions: [] }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { explore: allowAll },
        defaultAgent: denyEdit,
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("deny")
    }),
  )

  it.effect("an agent-less parent with a permissive default does not block the child", () =>
    Effect.gen(function* () {
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, permissions: [] }),
          sessionInfo({ id: child, parentID: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { explore: allowAll },
        defaultAgent: allowAll,
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("allow")
    }),
  )

  it.effect("forking cannot escape the intersection", () =>
    Effect.gen(function* () {
      // A fork keeps the source's authority - session affinity reads the same field as lineage - so
      // `fork.sessionID` has to join the ancestor walk, or a fork outruns its own source.
      const hook = yield* run({
        sessions: [
          sessionInfo({ id: parent, agent: Agent.ID.make("build"), permissions: denyEdit }),
          sessionInfo({ id: child, forkOf: parent, agent: Agent.ID.make("explore"), permissions: allowAll }),
        ],
        agents: { build: allowAll, explore: allowAll },
      })
      const event = evaluate(child)
      yield* hook(event)
      expect(event.effect).toBe("deny")
    }),
  )
})
