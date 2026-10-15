// Capability envelope audit (borrow C29). The card is computed from the same inputs core's
// `configured()` uses, so these tests pin the summary text (what the model is told, including that the
// verdicts are an upper bound) and the hook wiring: one report per session per process, on the
// session's own rules, and never a failed model request when the audit itself cannot run.
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { AUDIT_ACTIONS, envelopeSummary, ForkEnvelopePlugin } from "@opencode/core/plugin/fork/envelope"
import { testEffect } from "../../lib/effect"
import { host } from "../host"

const denyAll: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
const askEdit: Permission.Ruleset = [{ action: "edit", resource: "*", effect: "ask" }]

describe("envelopeSummary", () => {
  test("reports the verdict of every audited action and calls the result an upper bound", () => {
    const summary = envelopeSummary({ agent: "build", configured: askEdit, saved: 2 })
    expect(summary).toContain("agent build")
    expect(summary).toContain("1 configured rule(s)")
    expect(summary).toContain("2 saved approval(s)")
    expect(summary).toContain("Upper bound before plugin tightening:")
    expect(summary).toContain("edit=ask")
    // A ruleset that says nothing about an action leaves core at ask, not allow.
    expect(summary).toContain("shell=ask")
  })

  test("a deny-everything agent reads as deny everywhere", () => {
    const summary = envelopeSummary({ agent: "explore", configured: denyAll, saved: 0 })
    for (const action of AUDIT_ACTIONS) expect(summary).toContain(`${action}=deny`)
  })

  test("an explicit allow is reported as allow", () => {
    const summary = envelopeSummary({
      agent: "build",
      configured: [{ action: "shell", resource: "*", effect: "allow" }],
      saved: 0,
    })
    expect(summary).toContain("shell=allow")
    expect(summary).toContain("webfetch=ask")
  })
})

const it = testEffect(Layer.empty)

const sessionInfo = (id: SessionSchema.ID, permissions: Permission.Ruleset) =>
  SessionSchema.Info.make({
    id,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/workspace") },
    permissions,
  })

const context = (sessionID: SessionSchema.ID, agent: string): SessionContext =>
  ({
    sessionID,
    agent: Agent.ID.make(agent),
    system: [],
  }) as unknown as SessionContext

/** Runs the plugin against stubbed host APIs and captures its context hook. */
const run = Effect.fnUntraced(function* (input: {
  sessions: SessionSchema.Info[]
  agents: Record<string, Permission.Ruleset>
  saved?: number
  failSaved?: boolean
}) {
  let contextHook: ((event: SessionContext) => Effect.Effect<void>) | undefined
  const location = host().location
  const saved = Layer.succeed(PermissionSaved.Service, {
    list: () =>
      input.failSaved
        ? Effect.die("saved store unavailable")
        : Effect.succeed(Array.from({ length: input.saved ?? 0 }, () => ({})) as never),
    add: () => Effect.void,
    remove: () => Effect.void,
  })
  yield* ForkEnvelopePlugin.Plugin.effect(
    host({
      agent: {
        get: ({ agentID }: { agentID: Agent.ID }) =>
          input.agents[agentID] === undefined
            ? Effect.die(`no agent ${agentID}`)
            : Effect.succeed({
                location,
                data: { ...Agent.Info.default(Agent.ID.make(agentID)), permissions: input.agents[agentID] },
              }),
        list: () => Effect.die("unused agent.list"),
        transform: () => Effect.die("unused agent.transform"),
        reload: () => Effect.die("unused agent.reload"),
      },
      session: {
        hook: (name, callback) => {
          if (name === "context") contextHook = callback as (event: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        get: ({ sessionID }: { sessionID: SessionSchema.ID }) => {
          const found = input.sessions.find((session) => session.id === sessionID)
          return found === undefined ? Effect.die(`no session ${sessionID}`) : Effect.succeed(found)
        },
      },
    }),
  ).pipe(Effect.provide(saved))
  if (!contextHook) return yield* Effect.die("fork.permission-envelope did not register a context hook")
  return contextHook
})

const session = SessionSchema.ID.make("ses_envelope")
const other = SessionSchema.ID.make("ses_other")

describe("fork permission envelope: the hook", () => {
  it.effect("tells the model the envelope once per session, on the session's own rules", () =>
    Effect.gen(function* () {
      const hook = yield* run({ sessions: [sessionInfo(session, askEdit)], agents: { build: denyAll }, saved: 3 })
      const first = context(session, "build")
      yield* hook(first)
      expect(first.system).toHaveLength(1)
      const text = String((first.system[0] as { text?: string }).text)
      expect(text).toContain("3 saved approval(s)")
      // Session rules win over agent rules, so the session's ask survives the agent's deny-all.
      expect(text).toContain("edit=ask")

      const second = context(session, "build")
      yield* hook(second)
      expect(second.system).toHaveLength(0)
    }),
  )

  it.effect("reports a different session on its own first request", () =>
    Effect.gen(function* () {
      const hook = yield* run({ sessions: [sessionInfo(session, []), sessionInfo(other, [])], agents: { build: [] } })
      yield* hook(context(session, "build"))
      const next = context(other, "build")
      yield* hook(next)
      expect(next.system).toHaveLength(1)
    }),
  )

  it.effect("keeps a failing audit out of the model request", () =>
    Effect.gen(function* () {
      const hook = yield* run({ sessions: [sessionInfo(session, [])], agents: { build: [] }, failSaved: true })
      const event = context(session, "build")
      yield* hook(event)
      expect(event.system).toHaveLength(0)
    }),
  )
})
