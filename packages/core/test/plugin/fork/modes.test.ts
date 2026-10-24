import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { ForkModesPlugin } from "@opencode/core/plugin/fork/modes"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { Document, Info } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { tempGlobalLayer } from "../../fixture/global"
import { location } from "../../fixture/location"
import { testEffect } from "../../lib/effect"
import { agentHost, host } from "../host"

const sessionID = SessionSchema.ID.make("ses_fork_modes")
const workspace = AbsolutePath.make("/workspace")
const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node]), [
      Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory: workspace })))),
    ]),
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: workspace }))),
    Config.testLayer(),
    tempGlobalLayer,
  ),
)

const sessionInfo = (input: { parentID?: SessionSchema.ID; metadata?: Record<string, Schema.Json> } = {}) =>
  SessionSchema.Info.make({
    id: sessionID,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: workspace },
    ...input,
  })

const userMessage = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make(`msg_user_${text.length}`),
    type: "user",
    text,
    // Text starting with a slash stands for a command's expanded template.
    ...(text.startsWith("/") ? { metadata: { command: "review" } } : {}),
    time: { created: DateTime.makeUnsafe(0) },
  })

const assistantMessage = (agent: string) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(`msg_assistant_${agent}`),
    type: "assistant",
    agent: Agent.ID.make(agent),
    model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
    content: [],
    time: { created: DateTime.makeUnsafe(0) },
  })

const request = (agent: string, messages: Array<Message>): SessionContext => ({
  sessionID,
  agent: Agent.ID.make(agent),
  model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
  system: [],
  messages,
  tools: {},
  options: {},
})

const declared = (...ids: string[]) =>
  new Document({
    type: "document",
    info: new Info({ agents: Object.fromEntries(ids.map((id) => [id, new ConfigAgent.Info({})])) }),
  })

/** Runs the modes plugin against stubbed session reads, capturing metadata writes and the context hook. */
const run = Effect.fnUntraced(function* (
  input: {
    users?: ReadonlyArray<string>
    assistants?: ReadonlyArray<string>
    parentID?: SessionSchema.ID
    metadata?: Record<string, Schema.Json>
  } = {},
) {
  const updates = new Array<Record<string, Schema.Json> | undefined>()
  const state = { metadata: input.metadata }
  let contextHook: ((event: SessionContext) => Effect.Effect<void>) | undefined
  const agents = yield* Agent.Service
  const global = yield* Global.Service
  const sessions = Layer.mock(Session.Service, {
    revert: unusedRevert,
    messages: (query) =>
      Effect.succeed(
        (query.type === "user" ? (input.users ?? []).map(userMessage) : (input.assistants ?? []).map(assistantMessage))
          .toReversed()
          .slice(0, query.limit),
      ),
  })
  yield* ForkModesPlugin.Plugin.effect(
    host({
      agent: agentHost(agents),
      session: {
        hook: (name, callback) => {
          if (name === "context") contextHook = callback as (event: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        get: () => Effect.succeed(sessionInfo({ parentID: input.parentID, metadata: state.metadata })),
        update: (update) =>
          Effect.sync(() => {
            state.metadata = update.metadata
            updates.push(update.metadata)
          }),
      },
    }),
  ).pipe(Effect.provide(sessions))
  if (!contextHook) return yield* Effect.die("fork.modes did not register a context hook")
  return {
    updates,
    agents,
    global,
    contextHook,
    goalFile: path.join(global.data, "goals", `${sessionID}.md`),
  }
})

const unusedRevert = {
  stage: () => Effect.die("unused session.revert.stage"),
  clear: () => Effect.die("unused session.revert.clear"),
  commit: () => Effect.die("unused session.revert.commit"),
}

const systemTexts = (context: SessionContext) => context.system.map((part) => part.text)

const modeCardText = (context: SessionContext) =>
  systemTexts(context).find((text) => text.includes("Operational mode: "))

const goalCards = (context: SessionContext) =>
  systemTexts(context).filter((text) => text.startsWith("<system-reminder>\nThis session has a goal."))

describe("fork modes: standing mode cards", () => {
  it.effect("injects the card of each primary profile into the request system", () =>
    Effect.gen(function* () {
      for (const [agent, marker] of [
        ["auto", "Operational mode: auto"],
        ["goal", "Operational mode: goal"],
      ] as const) {
        const { contextHook } = yield* run({ users: [] })
        const context = request(agent, [Message.user("hello")])
        yield* contextHook(context)
        const card = modeCardText(context)!
        expect(card).toContain(marker)
        expect(card).toContain("There is no plan mode in this build")
        // The request messages stay untouched: no synthetic history, no spliced reminders.
        expect(context.messages).toHaveLength(1)
      }
    }),
  )

  it.effect("keeps the two contracts apart: auto runs no swarm, goal carries the closure contract", () =>
    Effect.gen(function* () {
      const auto = yield* run()
      const autoContext = request("auto", [Message.user("fix the flaky test")])
      yield* auto.contextHook(autoContext)
      const autoCard = modeCardText(autoContext)!
      expect(autoCard).toContain("goal-only")
      expect(autoCard).toContain("no mandatory todo list")
      expect(autoCard).toContain("report terse")

      const goal = yield* run()
      const goalContext = request("goal", [Message.user("close this out")])
      yield* goal.contextHook(goalContext)
      const goalCard = modeCardText(goalContext)!
      expect(goalCard).toContain("closure checklist")
      expect(goalCard).toContain("swarm playbook")
    }),
  )

  it.effect("carries the card on every request while the profile stays active", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run()
      const first = request("auto", [Message.user("hello")])
      yield* contextHook(first)
      const second = request("auto", [Message.user("hello"), Message.user("again")])
      yield* contextHook(second)
      expect(modeCardText(first)).toContain("Operational mode: auto")
      expect(modeCardText(second)).toContain("Operational mode: auto")
    }),
  )

  it.effect("swaps in the card of the new mode when the agent changes", () =>
    Effect.gen(function* () {
      const { contextHook } = yield* run()
      const auto = request("auto", [Message.user("start")])
      yield* contextHook(auto)
      const goal = request("goal", [Message.user("next")])
      yield* contextHook(goal)
      expect(systemTexts(goal).some((text) => text.includes("Operational mode: auto"))).toBe(false)
      expect(modeCardText(goal)).toContain("Operational mode: goal")
    }),
  )

  it.effect("adds no mode card for agents without a standing card", () =>
    Effect.gen(function* () {
      // build/plan are removed by the seat config, but the card table must not carry them
      // either: a re-enabled primary (upstream merge, local config change) would otherwise
      // silently resurrect a mode card.
      for (const agent of ["explore", "build", "plan"] as const) {
        const { contextHook } = yield* run()
        const context = request(agent, [Message.user("search")])
        yield* contextHook(context)
        expect(systemTexts(context)).toHaveLength(0)
        expect(context.messages).toHaveLength(1)
      }
    }),
  )
})

describe("fork modes: goal", () => {
  it.effect("seeds the goal from the first message in goal mode and mirrors it into session metadata", () =>
    Effect.gen(function* () {
      const { updates, contextHook, goalFile } = yield* run({ users: ["Ship the release"] })
      const context = request("goal", [Message.user("Ship the release")])
      yield* contextHook(context)
      expect(yield* Effect.promise(() => fs.readFile(goalFile, "utf8"))).toBe("Ship the release\n")
      expect(updates).toEqual([{ goal: { text: "Ship the release", path: goalFile } }])
      const card = goalCards(context)[0]!
      expect(card).toContain("Ship the release")
      expect(card).toContain(`The goal is stored at ${goalFile}.`)
      expect(context.messages).toHaveLength(1)
    }),
  )

  it.effect("does not seed the goal from a slash command's expanded template", () =>
    Effect.gen(function* () {
      const { updates, contextHook, goalFile } = yield* run({ users: ["/review the diff"] })
      const context = request("goal", [Message.user("/review the diff")])
      yield* contextHook(context)
      expect(yield* Effect.promise(() => fs.stat(goalFile).catch(() => undefined))).toBeUndefined()
      expect(updates).toHaveLength(0)
      expect(goalCards(context)).toHaveLength(0)
    }),
  )

  it.effect("does not seed outside goal mode, and later messages never rewrite the goal", () =>
    Effect.gen(function* () {
      const auto = yield* run({ users: ["do things"] })
      yield* auto.contextHook(request("auto", [Message.user("do things")]))
      expect(auto.updates).toHaveLength(0)
      expect(yield* Effect.promise(() => fs.stat(auto.goalFile).catch(() => undefined))).toBeUndefined()

      const goal = yield* run({ users: ["First objective", "Second message"] })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(goal.goalFile), { recursive: true })
        await fs.writeFile(goal.goalFile, "First objective\n")
      })
      yield* goal.contextHook(request("goal", [Message.user("Second message")]))
      expect(yield* Effect.promise(() => fs.readFile(goal.goalFile, "utf8"))).toBe("First objective\n")
    }),
  )

  it.effect("states the goal to any agent once a goal file exists", () =>
    Effect.gen(function* () {
      const { contextHook, goalFile } = yield* run({ users: ["x"] })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(goalFile), { recursive: true })
        await fs.writeFile(goalFile, "Migrate the billing service\n")
      })
      const context = request("auto", [Message.user("x")])
      yield* contextHook(context)
      expect(goalCards(context)[0]).toContain("Migrate the billing service")
    }),
  )

  it.effect("carries the edited goal and drops the card once the goal is cleared", () =>
    Effect.gen(function* () {
      const first = yield* run({ users: ["Alpha"] })
      yield* first.contextHook(request("goal", [Message.user("Alpha")]))

      const edited = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Alpha", path: first.goalFile } } })
      yield* Effect.promise(() => fs.writeFile(edited.goalFile, "Beta\n"))
      const editedContext = request("goal", [Message.user("next")])
      yield* edited.contextHook(editedContext)
      expect(goalCards(editedContext)[0]).toContain("Beta")
      expect(edited.updates).toEqual([{ goal: { text: "Beta", path: first.goalFile } }])

      // The card is rebuilt per request, so an unchanged goal keeps stating itself.
      const stable = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Beta", path: first.goalFile } } })
      const stableContext = request("goal", [Message.user("again")])
      yield* stable.contextHook(stableContext)
      expect(goalCards(stableContext)[0]).toContain("Beta")
      expect(stable.updates).toHaveLength(0)

      const cleared = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Beta", path: first.goalFile } } })
      yield* Effect.promise(() => fs.writeFile(cleared.goalFile, ""))
      const clearedContext = request("goal", [Message.user("later")])
      yield* cleared.contextHook(clearedContext)
      expect(goalCards(clearedContext)).toHaveLength(0)
      // Cleared on purpose: the empty file is not seeded again from the user's message.
      expect(yield* Effect.promise(() => fs.readFile(cleared.goalFile, "utf8"))).toBe("")
      expect(cleared.updates).toEqual([{}])
    }),
  )

  it.effect("keeps other session metadata when the goal is mirrored or cleared", () =>
    Effect.gen(function* () {
      const { updates, contextHook, goalFile } = yield* run({ users: ["Alpha"], metadata: { owner: "host" } })
      yield* contextHook(request("goal", [Message.user("Alpha")]))
      expect(updates).toEqual([{ owner: "host", goal: { text: "Alpha", path: goalFile } }])
    }),
  )

  it.effect("truncates a very long goal in the card", () =>
    Effect.gen(function* () {
      const long = "g".repeat(9000)
      const { contextHook } = yield* run({ users: [long] })
      const context = request("goal", [Message.user(long)])
      yield* contextHook(context)
      const card = goalCards(context)[0]!
      expect(card).toContain(`${"g".repeat(8000)}\n(truncated)`)
      expect(card).not.toContain("g".repeat(8001))
    }),
  )

  it.effect("leaves subagent sessions without a goal", () =>
    Effect.gen(function* () {
      const { updates, contextHook, goalFile } = yield* run({
        users: ["Explore this"],
        parentID: SessionSchema.ID.make("ses_parent"),
      })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(goalFile), { recursive: true })
        await fs.writeFile(goalFile, "Not for children\n")
      })
      const context = request("goal", [Message.user("Explore this")])
      yield* contextHook(context)
      expect(goalCards(context)).toHaveLength(0)
      expect(updates).toHaveLength(0)
    }),
  )
})

describe("fork modes: agents", () => {
  it.effect("lists configured agents in declaration order after the default", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const config = yield* Config.Test
      yield* agents.transform((editor) => {
        ;["general", "explore", "auto", "goal"].forEach((id) =>
          editor.update(Agent.ID.make(id), (agent) => {
            agent.mode = id === "general" || id === "explore" ? "subagent" : "primary"
          }),
        )
        editor.default(Agent.ID.make("auto"))
      })
      yield* config.setEntries([declared("auto", "goal", "general")])
      expect((yield* agents.list()).map((agent) => String(agent.id))).toEqual(["auto", "general", "explore", "goal"])
      yield* ForkModesPlugin.Plugin.effect(host({ agent: agentHost(agents), session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })).pipe(
        Effect.provide(Layer.mock(Session.Service, { revert: unusedRevert })),
      )
      expect((yield* agents.list()).map((agent) => String(agent.id))).toEqual(["auto", "goal", "general", "explore"])
    }),
  )

  it.effect("re-asserts the built-in profile rules after a global permission", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const config = yield* Config.Test
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("auto"), (agent) => {
          agent.mode = "primary"
          // Simulates ConfigAgentPlugin pushing the operator's global `permission: "allow"` after
          // ForkProfilesPlugin created the built-in profile.
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
      })
      yield* config.setEntries([])
      yield* ForkModesPlugin.Plugin.effect(
        host({ agent: agentHost(agents), session: { hook: () => Effect.succeed({ dispose: Effect.void }) } }),
      ).pipe(Effect.provide(Layer.mock(Session.Service, { revert: unusedRevert })))

      const auto = yield* agents.get(Agent.ID.make("auto"))
      expect(Permission.evaluate("edit", "/home/someone/.config/opencode/opencode.jsonc", auto?.permissions ?? []).effect).toBe(
        "deny",
      )
      expect(auto?.permissions.some((rule) => rule.action === "question" && rule.effect === "deny")).toBe(true)
    }),
  )
})
