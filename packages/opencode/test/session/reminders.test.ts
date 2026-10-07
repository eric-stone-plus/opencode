import { describe, expect } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import * as SessionReminders from "../../src/session/reminders"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import PROMPT_AUTO_MODE from "../../src/session/prompt/auto-mode.txt"
import PROMPT_BUILD_MODE from "../../src/session/prompt/build-mode.txt"
import PROMPT_PLAN from "../../src/session/prompt/plan.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([Session.node, SessionProjector.node, FSUtil.node, CrossSpawnSpawner.node, EventV2Bridge.node]),
    ),
    RuntimeFlags.layer({ experimentalPlanMode: false }),
  ),
)

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const agent = (name: string) => ({ name, mode: "primary", permission: [], options: {} }) as unknown as Agent.Info

const user = Effect.fn("test.user")(function* (
  sessionID: SessionID,
  name: string,
  text = "go",
  metadata?: Record<string, unknown>,
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: name,
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
    ...(metadata ? { metadata } : {}),
  })
  return msg
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, name: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: name,
    agent: name,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const apply = Effect.fn("test.apply")(function* (sessionID: SessionID, name: string, subagents?: ReadonlySet<string>) {
  const session = yield* Session.Service
  const info = yield* session.get(sessionID)
  const messages = yield* session.messages({ sessionID })
  return yield* SessionReminders.apply({ messages, agent: agent(name), session: info, subagents })
})

const writeGoal = Effect.fn("test.writeGoal")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const fsys = yield* FSUtil.Service
  const ctx = yield* InstanceState.context
  yield* fsys.writeWithDirs(Session.goal(yield* session.get(sessionID), ctx), text).pipe(Effect.orDie)
})

// Model-visible synthetic text in order, across every message (what the provider sees).
const all = (messages: readonly SessionV1.WithParts[]) =>
  messages.flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))

// Snapshot of each message's parts as persisted, keyed by message id.
const snapshot = (messages: readonly SessionV1.WithParts[]) =>
  messages.map((msg) => JSON.stringify(msg.parts.map((part) => (part.type === "text" ? part.text : part.type))))

const texts = (messages: readonly SessionV1.WithParts[]) =>
  messages.findLast((msg) => msg.info.role === "user")!.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))

describe("SessionReminders.apply", () => {
  it.live(
    "auto gets its standing card and never the plan prompt",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* user(id, "auto")
        const out = texts(yield* apply(id, "auto"))
        expect(out).toContain(PROMPT_AUTO_MODE)
        expect(out).not.toContain(PROMPT_PLAN)
      }),
    ),
  )

  it.live(
    "plan gets the plan prompt and no auto card",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* user(id, "plan")
        const out = texts(yield* apply(id, "plan"))
        expect(out).toContain(PROMPT_PLAN)
        expect(out).not.toContain(PROMPT_AUTO_MODE)
      }),
    ),
  )

  it.live(
    "leaving plan persists the transition card exactly once",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "plan")
        yield* assistant(id, first.id, "plan")
        yield* user(id, "auto")
        yield* apply(id, "auto")
        const out = texts(yield* apply(id, "auto"))
        expect(out.filter((text) => text === BUILD_SWITCH)).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "a compaction between the plan turn and the switch does not hide the transition",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "plan")
        yield* assistant(id, first.id, "plan")
        const second = yield* user(id, "plan")
        yield* assistant(id, second.id, "compaction")
        yield* user(id, "auto")
        expect(texts(yield* apply(id, "auto"))).toContain(BUILD_SWITCH)
      }),
    ),
  )

  it.live(
    "no transition card when the previous turn was not plan",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "auto")
        yield* assistant(id, first.id, "auto")
        yield* user(id, "auto")
        expect(texts(yield* apply(id, "auto"))).not.toContain(BUILD_SWITCH)
      }),
    ),
  )

  it.live(
    "a subtask turn between the plan turn and the switch does not hide the transition",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "plan")
        yield* assistant(id, first.id, "plan")
        // A subtask command (e.g. /review) records its assistant message under the subagent's name.
        const second = yield* user(id, "plan")
        yield* assistant(id, second.id, "explore")
        yield* user(id, "auto")
        expect(texts(yield* apply(id, "auto", new Set(["explore"])))).toContain(BUILD_SWITCH)
      }),
    ),
  )

  it.live(
    "standing cards are persisted once and earlier messages never change across turns",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* writeGoal(id, "ship the cache fix")
        const first = yield* user(id, "auto")
        yield* apply(id, "auto")
        // A second loop step in the same turn reloads from the DB and adds nothing.
        const step = yield* apply(id, "auto")
        expect(texts(step).filter((text) => text === PROMPT_AUTO_MODE)).toHaveLength(1)
        expect(texts(step).filter((text) => text.includes("ship the cache fix"))).toHaveLength(1)
        yield* assistant(id, first.id, "auto")
        const before = snapshot(yield* session.messages({ sessionID: id }))
        yield* user(id, "auto")
        const out = yield* apply(id, "auto")
        // Prefix (everything before the new user message) is byte-identical.
        expect(snapshot(out).slice(0, before.length)).toEqual(before)
        // Unchanged mode / goal: the new user message gets no repeated card.
        expect(texts(out)).toEqual(["go"])
        expect(all(out).filter((text) => text === PROMPT_AUTO_MODE)).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "a mode switch persists the new card on the new user message",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "auto")
        yield* apply(id, "auto")
        yield* assistant(id, first.id, "auto")
        yield* user(id, "build")
        const out = yield* apply(id, "build")
        expect(texts(out)).toContain(PROMPT_BUILD_MODE)
        // Switching back to auto re-announces auto: the latest card is build now.
        const second = out.findLast((msg) => msg.info.role === "user")!
        yield* assistant(id, second.info.id, "build")
        yield* user(id, "auto")
        expect(texts(yield* apply(id, "auto"))).toContain(PROMPT_AUTO_MODE)
      }),
    ),
  )

  it.live(
    "switching to an agent without a standing card supersedes the old card",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "auto")
        yield* apply(id, "auto")
        yield* assistant(id, first.id, "auto")
        yield* user(id, "custom")
        const out = texts(yield* apply(id, "custom"))
        expect(out.some((text) => text.includes("Operational mode: custom") && text.includes("superseded"))).toBe(true)
      }),
    ),
  )

  it.live(
    "an agent without a standing card never gets one on a fresh session",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* user(id, "custom")
        expect(texts(yield* apply(id, "custom"))).toEqual(["go"])
      }),
    ),
  )

  it.live(
    "a goal edit injects a superseding reminder; clearing the goal says so",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* writeGoal(id, "goal one")
        const first = yield* user(id, "auto")
        yield* apply(id, "auto")
        yield* assistant(id, first.id, "auto")
        yield* writeGoal(id, "goal two")
        const second = yield* user(id, "auto")
        const out = texts(yield* apply(id, "auto"))
        const reminder = out.find((text) => text.includes("goal two"))
        expect(reminder).toContain("The session goal changed")
        expect(out.some((text) => text.includes("goal one"))).toBe(false)
        yield* assistant(id, second.id, "auto")
        yield* writeGoal(id, "")
        yield* user(id, "auto")
        expect(texts(yield* apply(id, "auto")).some((text) => text.includes("goal has been cleared"))).toBe(true)
      }),
    ),
  )

  it.live(
    "entering goal mode with no goal file seeds it from the message and publishes goal.updated",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const fsys = yield* FSUtil.Service
        const { id } = yield* session.create({})
        const seen: string[] = []
        const unsub = yield* events.listen((event) => {
          if (event.type === "goal.updated") seen.push((event.data as { text: string }).text)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)
        yield* user(id, "goal", "ship the acceptance report")
        const out = texts(yield* apply(id, "goal"))
        expect(out.some((text) => text.includes("ship the acceptance report"))).toBe(true)
        const goalPath = Session.goal(yield* session.get(id), yield* InstanceState.context)
        expect(yield* fsys.readFileStringSafe(goalPath)).toBe("ship the acceptance report")
        expect(seen).toEqual(["ship the acceptance report"])
      }),
    ),
  )

  it.live(
    "a command message does not seed the goal",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const fsys = yield* FSUtil.Service
        const { id } = yield* session.create({})
        const seen: string[] = []
        const unsub = yield* events.listen((event) => {
          if (event.type === "goal.updated") seen.push((event.data as { text: string }).text)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)
        // Command templates are marked with metadata.command (prompt.ts); they
        // are the user's keystrokes only in the sense that they invoked the
        // command, so they must not become the objective.
        yield* user(id, "goal", "# Init\n\nCreate or update AGENTS.md", { command: "init" })
        yield* apply(id, "goal")
        const goalPath = Session.goal(yield* session.get(id), yield* InstanceState.context)
        expect(yield* fsys.readFileStringSafe(goalPath)).toBeUndefined()
        expect(seen).toEqual([])
      }),
    ),
  )

  it.live(
    "a goal edited mid-turn appends one superseding reminder on the same message",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        yield* writeGoal(id, "goal one")
        yield* user(id, "auto")
        yield* apply(id, "auto")
        yield* writeGoal(id, "goal two")
        yield* apply(id, "auto")
        const out = texts(yield* apply(id, "auto"))
        expect(out.filter((text) => text.includes("goal two"))).toHaveLength(1)
        expect(out.filter((text) => text === PROMPT_AUTO_MODE)).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "a card compacted out of context is re-injected",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { id } = yield* session.create({})
        const first = yield* user(id, "auto")
        yield* apply(id, "auto")
        yield* assistant(id, first.id, "auto")
        yield* user(id, "auto")
        const messages = yield* session.messages({ sessionID: id })
        // Simulate filterCompacted dropping the first turn.
        const info = yield* session.get(id)
        const out = yield* SessionReminders.apply({ messages: messages.slice(2), agent: agent("auto"), session: info })
        expect(texts(out)).toContain(PROMPT_AUTO_MODE)
      }),
    ),
  )
})
