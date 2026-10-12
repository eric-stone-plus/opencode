import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Message } from "@opencode/ai"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { ForkAutonomyPlugin } from "@opencode/core/plugin/fork/autonomy"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionSchema } from "@opencode/core/session/schema"
import { Skill } from "@opencode/core/skill"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../../lib/effect"
import { toolIdentity } from "../../lib/tool"
import { agentHost, host } from "../host"

const sessionID = SessionSchema.ID.make("ses_fork_autonomy")
const workspace = AbsolutePath.make("/workspace")

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Bus.node])))

const sessionInfo = (permissions: Permission.Ruleset) =>
  SessionSchema.Info.make({
    id: sessionID,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: workspace },
    permissions,
  })

const unusedRevert = {
  stage: () => Effect.die("unused session.revert.stage"),
  clear: () => Effect.die("unused session.revert.clear"),
  commit: () => Effect.die("unused session.revert.commit"),
}

const demoSkill = Skill.Info.make({
  id: Skill.ID.make("demo"),
  name: Skill.Name.make("Demo"),
  path: AbsolutePath.make("/skills/demo/SKILL.md"),
  content: "body",
})

const request = (agent: string, messages: Array<Message>): SessionContext => ({
  sessionID,
  agent: Agent.ID.make(agent),
  model: { id: "test-model" as never, providerID: "test" as never },
  system: [],
  messages,
  tools: {},
  options: {},
})

type After = ToolHooks["execute.after"]
type CompletedEvent = Extract<After, { status: "completed" }>

const skillEvent = (): CompletedEvent =>
  ({
    tool: "skill",
    sessionID,
    agent: Agent.ID.make("auto"),
    messageID: toolIdentity.messageID,
    id: "call-skill" as never,
    input: { id: "demo" },
    status: "completed",
    result: { content: "<skill_content>\nbody\n</skill_content>" },
  }) as CompletedEvent

/** Runs the plugin against stubbed session state and captures its two hooks. */
const run = Effect.fnUntraced(function* (input: {
  agentRules?: Permission.Ruleset
  sessionRules?: Permission.Ruleset
  skills?: ReadonlyArray<Skill.Info>
} = {}) {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("auto"), (agent) => {
      agent.mode = "primary"
      for (const rule of input.agentRules ?? []) agent.permissions.push(rule)
    })
  })
  let contextHook: ((event: SessionContext) => Effect.Effect<void>) | undefined
  let toolHook: ((event: After) => Effect.Effect<void>) | undefined
  const sessions = Layer.mock(Session.Service, {
    revert: unusedRevert,
    get: () => Effect.succeed(sessionInfo(input.sessionRules ?? [])),
  })
  const skills = Layer.mock(Skill.Service, {
    list: () => Effect.succeed([...(input.skills ?? [demoSkill])]),
  })
  yield* ForkAutonomyPlugin.Plugin.effect(
    host({
      agent: agentHost(agents),
      session: {
        hook: (name, callback) => {
          if (name === "context") contextHook = callback as (event: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name, callback) => {
          if (name === "execute.after") toolHook = callback as (event: After) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  ).pipe(Effect.provide(sessions), Effect.provide(skills))
  if (!contextHook) return yield* Effect.die("fork.autonomy did not register a context hook")
  if (!toolHook) return yield* Effect.die("fork.autonomy did not register a tool hook")
  return { contextHook, toolHook }
})

const denied = [{ action: "question", resource: "*", effect: "deny" }] as Permission.Ruleset

describe("fork autonomy: the contract", () => {
  it.effect("injects the contract when the agent denies question and skills exist", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run({ agentRules: denied })
      const context = request("auto", [Message.user("hi")])
      yield* contextHook(context)
      const system = context.system.map((part) => part.text).join("\n")
      expect(system).toContain("# Running without a human")
      expect(system).toContain("Chose X because Y")
    }),
  )

  it.effect("injects the contract when the session denies question (opencode run)", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run({ sessionRules: denied })
      const context = request("auto", [Message.user("hi")])
      yield* contextHook(context)
      expect(context.system.map((part) => part.text).join("\n")).toContain("# Running without a human")
    }),
  )

  it.effect("adds nothing when question is allowed", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run()
      const context = request("auto", [Message.user("hi")])
      yield* contextHook(context)
      expect(context.system).toHaveLength(0)
    }),
  )

  it.effect("adds nothing without available skills", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run({ agentRules: denied, skills: [] })
      const context = request("auto", [Message.user("hi")])
      yield* contextHook(context)
      expect(context.system).toHaveLength(0)
    }),
  )
})

describe("fork autonomy: the skill reminder", () => {
  it.effect("appends the reminder after the loaded skill", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run({ agentRules: denied })
      const event = skillEvent()
      yield* toolHook(event)
      const content = String(event.result.content)
      expect(content).toContain("<skill_content>")
      expect(content).toContain("Chose X because Y")
      expect(content.endsWith("rest of the work.")).toBe(true)
    }),
  )

  it.effect("leaves the result alone when question is allowed", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      const event = skillEvent()
      yield* toolHook(event)
      expect(event.result.content).toBe("<skill_content>\nbody\n</skill_content>")
    }),
  )

  it.effect("ignores other tools", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run({ agentRules: denied })
      const event = { ...skillEvent(), tool: "read" }
      yield* toolHook(event)
      expect(event.result.content).toBe("<skill_content>\nbody\n</skill_content>")
    }),
  )
})
