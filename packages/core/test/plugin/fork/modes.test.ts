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
import { SessionInbox } from "@opencode/core/session/inbox"
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

/** Runs the modes plugin against stubbed session reads, capturing persisted reminders and metadata writes. */
const run = Effect.fnUntraced(function* (
  input: {
    users?: ReadonlyArray<string>
    assistants?: ReadonlyArray<string>
    parentID?: SessionSchema.ID
    metadata?: Record<string, Schema.Json>
  } = {},
) {
  const persisted = new Array<string>()
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
        synthetic: (synthetic) => {
          persisted.push(synthetic.text)
          return Effect.succeed(
            SessionInbox.Synthetic.make({
              id: SessionMessage.ID.make(`msg_card_${persisted.length}`),
              sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "synthetic",
              payload: { text: synthetic.text },
              delivery: "steer",
            }),
          )
        },
      },
    }),
  ).pipe(Effect.provide(sessions))
  if (!contextHook) return yield* Effect.die("fork.modes did not register a context hook")
  return {
    persisted,
    updates,
    agents,
    global,
    contextHook,
    goalFile: path.join(global.data, "goals", `${sessionID}.md`),
    planFile: path.join(global.data, "plans", `${sessionID}.md`),
  }
})

const goalCards = (persisted: ReadonlyArray<string>) =>
  persisted.filter(
    (text) =>
      text.startsWith("<system-reminder>\nThis session has a goal.") ||
      text.startsWith("<system-reminder>\nThe session goal "),
  )

const unusedRevert = {
  stage: () => Effect.die("unused session.revert.stage"),
  clear: () => Effect.die("unused session.revert.clear"),
  commit: () => Effect.die("unused session.revert.commit"),
}

const texts = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => {
    const part = message.content[0]
    return part?.type === "text" ? part.text : ""
  })

describe("fork modes: standing mode cards", () => {
  it.effect("injects the card of each primary profile once and persists it", () =>
    Effect.gen(function* () {
      for (const [agent, marker] of [
        ["auto", "Operational mode: auto"],
        ["goal", "Operational mode: goal"],
        ["build", "Operational mode: build"],
      ] as const) {
        const { persisted, contextHook } = yield* run({ users: [] })
        const messages = [Message.user("hello")]
        yield* contextHook(request(agent, messages))
        // Before the user's prompt, so the prompt stays last.
        expect(messages).toHaveLength(2)
        expect(texts(messages)[0]).toContain(marker)
        expect(texts(messages)[0]).toContain("Plan mode is NOT active")
        expect(texts(messages)[1]).toBe("hello")
        expect(persisted.filter((text) => text.includes("Operational mode"))).toHaveLength(1)
      }
    }),
  )

  it.effect("does nothing while the live card already matches the agent", () =>
    Effect.gen(function* () {
      const first = yield* run()
      const seed = [Message.user("hello")]
      yield* first.contextHook(request("auto", seed))
      const card = first.persisted[0]!
      const second = yield* run()
      const messages = [Message.user(card), Message.user("again")]
      yield* second.contextHook(request("auto", messages))
      expect(messages).toHaveLength(2)
      expect(second.persisted).toHaveLength(0)
    }),
  )

  it.effect("supersedes the card of another mode when the agent changes", () =>
    Effect.gen(function* () {
      const first = yield* run()
      const messages = [Message.user("start")]
      yield* first.contextHook(request("auto", messages))
      const second = yield* run()
      const history = [...messages.slice(0, -1), Message.user("next")]
      yield* second.contextHook(request("goal", history))
      expect(texts(history).some((text) => text.includes("Operational mode: goal"))).toBe(true)
      expect(second.persisted.some((text) => text.includes("Operational mode: goal"))).toBe(true)
    }),
  )

  it.effect("retires a stale card with a neutral one for agents without a standing card", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user("start")]
      yield* contextHook(request("build", messages))
      const history = [...messages.slice(0, -1), Message.user("ask")]
      yield* contextHook(request("reviewer", history))
      expect(persisted.at(-1)).toContain("Operational mode: reviewer. Earlier operational-mode reminders")
    }),
  )

  it.effect("writes nothing for an agent without a card when history has no mode card", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user("search")]
      yield* contextHook(request("explore", messages))
      expect(messages).toHaveLength(1)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("treats a card quoted inside a larger message as not live", () =>
    Effect.gen(function* () {
      const first = yield* run()
      yield* first.contextHook(request("auto", [Message.user("x")]))
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user(`<conversation-checkpoint>\n${first.persisted[0]}\n</conversation-checkpoint>`)]
      yield* contextHook(request("auto", messages))
      expect(persisted).toHaveLength(1)
    }),
  )

  it.effect("does not persist a reminder again when a retry rebuilds the request before promotion", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      const first = [Message.user("hello")]
      const retry = [Message.user("hello")]
      yield* contextHook(request("auto", first))
      yield* contextHook(request("auto", retry))
      expect(persisted).toHaveLength(1)
      // The retry still shows the model the reminder that is waiting in the inbox.
      expect(texts(retry)[0]).toContain("Operational mode: auto")
    }),
  )

  it.effect("persists the reminder again once compaction removed it from history", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      yield* contextHook(request("auto", [Message.user("hello")]))
      // Promoted into history, then summarised away.
      yield* contextHook(request("auto", [Message.user(persisted[0]!), Message.user("more")]))
      yield* contextHook(request("auto", [Message.user("after compaction")]))
      expect(persisted).toHaveLength(2)
    }),
  )
})

describe("fork modes: plan cards", () => {
  it.effect("gives the plan agent the workflow card with its plan file", () =>
    Effect.gen(function* () {
      const { persisted, contextHook, planFile } = yield* run()
      const messages = [Message.user("design this")]
      yield* contextHook(request("plan", messages))
      expect(texts(messages)[0]).toContain("Plan mode is active")
      expect(texts(messages)[0]).toContain(`Your plan file is ${planFile}.`)
      expect(texts(messages)[0]).toContain("Call the plan_exit tool")
      expect(persisted).toHaveLength(1)
      expect((yield* Effect.promise(() => fs.stat(path.dirname(planFile)))).isDirectory()).toBe(true)
    }),
  )

  it.effect("carries one transition card on the first request after leaving plan", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run({ assistants: ["plan"] })
      const messages = [Message.user("go")]
      yield* contextHook(request("build", messages))
      expect(persisted.some((text) => text.includes("Plan mode has ended"))).toBe(true)
      expect(persisted.some((text) => text.includes("A plan file exists at"))).toBe(false)
      // The next assistant message ran under build, so the transition is over.
      const later = yield* run({ assistants: ["plan", "build"] })
      yield* later.contextHook(request("build", [Message.user("go on")]))
      expect(later.persisted.some((text) => text.includes("Plan mode has ended"))).toBe(false)
    }),
  )

  it.effect("points the transition card at an existing plan file", () =>
    Effect.gen(function* () {
      const { persisted, contextHook, planFile } = yield* run({ assistants: ["plan"] })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(planFile), { recursive: true })
        await fs.writeFile(planFile, "# plan")
      })
      yield* contextHook(request("auto", [Message.user("go")]))
      expect(persisted.find((text) => text.includes("Plan mode has ended"))).toContain(
        `A plan file exists at ${planFile}. You should execute on the plan defined within it`,
      )
    }),
  )

  it.effect("does not repeat the transition card when it is already in the tail", () =>
    Effect.gen(function* () {
      const first = yield* run({ assistants: ["plan"] })
      yield* first.contextHook(request("build", [Message.user("go")]))
      const transition = first.persisted.find((text) => text.includes("Plan mode has ended"))!
      const second = yield* run({ assistants: ["plan"] })
      const messages = [
        Message.assistant("planning done"),
        Message.user(transition),
        Message.user("go"),
      ]
      yield* second.contextHook(request("build", messages))
      expect(second.persisted.some((text) => text.includes("Plan mode has ended"))).toBe(false)
    }),
  )
})

describe("fork modes: goal", () => {
  it.effect("seeds the goal from the first message in goal mode and mirrors it into session metadata", () =>
    Effect.gen(function* () {
      const { persisted, updates, contextHook, goalFile } = yield* run({ users: ["Ship the release"] })
      const messages = [Message.user("Ship the release")]
      yield* contextHook(request("goal", messages))
      expect(yield* Effect.promise(() => fs.readFile(goalFile, "utf8"))).toBe("Ship the release\n")
      expect(updates).toEqual([{ goal: { text: "Ship the release", path: goalFile } }])
      const card = persisted.find((text) => text.includes("This session has a goal."))
      expect(card).toContain("Ship the release")
      expect(card).toContain(`The goal is stored at ${goalFile}.`)
      expect(texts(messages).at(-1)).toBe("Ship the release")
    }),
  )

  it.effect("does not seed the goal from a slash command's expanded template", () =>
    Effect.gen(function* () {
      const { persisted, updates, contextHook, goalFile } = yield* run({ users: ["/review the diff"] })
      yield* contextHook(request("goal", [Message.user("/review the diff")]))
      expect(yield* Effect.promise(() => fs.stat(goalFile).catch(() => undefined))).toBeUndefined()
      expect(updates).toHaveLength(0)
      expect(persisted.some((text) => text.includes("This session has a goal."))).toBe(false)
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
      const { persisted, contextHook, goalFile } = yield* run({ users: ["x"] })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(goalFile), { recursive: true })
        await fs.writeFile(goalFile, "Migrate the billing service\n")
      })
      yield* contextHook(request("build", [Message.user("x")]))
      expect(persisted.some((text) => text.includes("Migrate the billing service"))).toBe(true)
    }),
  )

  it.effect("announces an edited goal as superseding the earlier card and retires a cleared one", () =>
    Effect.gen(function* () {
      const first = yield* run({ users: ["Alpha"] })
      yield* first.contextHook(request("goal", [Message.user("Alpha")]))
      const original = first.persisted.find((text) => text.includes("This session has a goal."))!

      const edited = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Alpha", path: first.goalFile } } })
      yield* Effect.promise(() => fs.writeFile(edited.goalFile, "Beta\n"))
      yield* edited.contextHook(request("goal", [Message.user(original), Message.user("next")]))
      const changed = edited.persisted.find((text) => text.includes("Beta"))!
      expect(changed).toContain("The session goal changed; this replaces any earlier goal reminder.")
      expect(edited.updates).toEqual([{ goal: { text: "Beta", path: first.goalFile } }])

      // The edited card is itself current history: an unchanged goal adds nothing.
      const stable = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Beta", path: first.goalFile } } })
      yield* stable.contextHook(request("goal", [Message.user(changed), Message.user("again")]))
      expect(goalCards(stable.persisted)).toHaveLength(0)
      expect(stable.updates).toHaveLength(0)

      const cleared = yield* run({ users: ["Alpha"], metadata: { goal: { text: "Beta", path: first.goalFile } } })
      yield* Effect.promise(() => fs.writeFile(cleared.goalFile, ""))
      yield* cleared.contextHook(request("goal", [Message.user(changed), Message.user("later")]))
      expect(goalCards(cleared.persisted)).toEqual([expect.stringContaining("The session goal has been cleared.")])
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
      const { persisted, contextHook } = yield* run({ users: [long] })
      yield* contextHook(request("goal", [Message.user(long)]))
      const card = persisted.find((text) => text.includes("This session has a goal."))!
      expect(card).toContain(`${"g".repeat(8000)}\n(truncated)`)
      expect(card).not.toContain("g".repeat(8001))
    }),
  )

  it.effect("leaves subagent sessions without a goal", () =>
    Effect.gen(function* () {
      const { persisted, updates, contextHook, goalFile } = yield* run({
        users: ["Explore this"],
        parentID: SessionSchema.ID.make("ses_parent"),
      })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(goalFile), { recursive: true })
        await fs.writeFile(goalFile, "Not for children\n")
      })
      yield* contextHook(request("goal", [Message.user("Explore this")]))
      expect(persisted.some((text) => text.includes("This session has a goal."))).toBe(false)
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
        ;["build", "general", "explore", "plan", "auto", "goal"].forEach((id) =>
          editor.update(Agent.ID.make(id), (agent) => {
            agent.mode = id === "general" || id === "explore" ? "subagent" : "primary"
          }),
        )
        editor.default(Agent.ID.make("auto"))
      })
      yield* config.setEntries([declared("auto", "goal", "build", "plan", "general")])
      expect((yield* agents.list()).map((agent) => String(agent.id))).toEqual([
        "auto",
        "build",
        "general",
        "explore",
        "plan",
        "goal",
      ])
      yield* ForkModesPlugin.Plugin.effect(host({ agent: agentHost(agents), session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })).pipe(
        Effect.provide(Layer.mock(Session.Service, { revert: unusedRevert })),
      )
      expect((yield* agents.list()).map((agent) => String(agent.id))).toEqual([
        "auto",
        "goal",
        "build",
        "plan",
        "general",
        "explore",
      ])
    }),
  )

  it.effect("lets the plan agent write its own plan file after config denied edits", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const config = yield* Config.Test
      const global = yield* Global.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("plan"), (agent) => {
          agent.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        }),
      )
      yield* config.setEntries([declared("plan")])
      yield* ForkModesPlugin.Plugin.effect(host({ agent: agentHost(agents), session: { hook: () => Effect.succeed({ dispose: Effect.void }) } })).pipe(
        Effect.provide(Layer.mock(Session.Service, { revert: unusedRevert })),
      )
      const plan = yield* agents.get(Agent.ID.make("plan"))
      const file = path.join(global.data, "plans", `${sessionID}.md`)
      expect(Permission.evaluate("edit", file, plan!.permissions).effect).toBe("allow")
      // The location-relative form the file tools report for a plan file inside the location.
      expect(
        Permission.evaluate("edit", path.relative(workspace, file).replaceAll("\\", "/"), plan!.permissions).effect,
      ).toBe("allow")
      expect(Permission.evaluate("edit", "/workspace/src/index.ts", plan!.permissions).effect).toBe("deny")
    }),
  )
})
