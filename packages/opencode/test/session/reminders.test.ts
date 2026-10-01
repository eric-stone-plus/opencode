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
import { Session } from "@/session/session"
import * as SessionReminders from "../../src/session/reminders"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import PROMPT_AUTO_MODE from "../../src/session/prompt/auto-mode.txt"
import PROMPT_PLAN from "../../src/session/prompt/plan.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, FSUtil.node, CrossSpawnSpawner.node])),
    RuntimeFlags.layer({ experimentalPlanMode: false }),
  ),
)

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const agent = (name: string) => ({ name, mode: "primary", permission: [], options: {} }) as unknown as Agent.Info

const user = Effect.fn("test.user")(function* (sessionID: SessionID, name: string, text = "go") {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: name,
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
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
})
