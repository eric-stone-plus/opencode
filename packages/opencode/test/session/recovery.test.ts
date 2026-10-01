import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import { SessionRecovery } from "@/session/recovery"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceState } from "@/effect/instance-state"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      SessionRecovery.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// Writes the state a crashed run leaves behind: an assistant message without
// time.completed, a running and a pending tool part, a text fragment and an
// empty reasoning part.
const crashed = Effect.fn("test.crashed")(function* (sessionID: SessionID) {
  const session = yield* SessionNs.Service
  const ctx = yield* InstanceState.context
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text: "do work",
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID: user.id,
    mode: "build",
    agent: "build",
    path: { cwd: ctx.directory, root: ctx.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  const reasoning = yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "reasoning",
    text: "",
    time: { start: Date.now() },
  })
  const text = yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "partial answer",
    time: { start: Date.now() },
  })
  const running = yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "tool",
    tool: "bash",
    callID: "call-running",
    state: { status: "running", input: { command: "sleep 100" }, metadata: { output: "half" }, time: { start: 1 } },
  } satisfies SessionV1.ToolPart)
  const pending = yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "tool",
    tool: "read",
    callID: "call-pending",
    state: { status: "pending", input: {}, raw: "" },
  } satisfies SessionV1.ToolPart)
  return { assistant, reasoning, text, running, pending }
})

describe("session.recovery", () => {
  it.instance("marks runs left by a dead process as interrupted", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const recovery = yield* SessionRecovery.Service
      const ctx = yield* InstanceState.context
      const chat = yield* session.create({})
      const left = yield* crashed(chat.id)

      const result = yield* recovery.sweep(ctx.directory, Date.now() + 1000)
      expect(result.messages).toBe(1)

      const messages = yield* session.messages({ sessionID: chat.id })
      const info = messages.find((msg) => msg.info.id === left.assistant.id)!
      if (info.info.role !== "assistant") throw new Error("expected assistant")
      expect(info.info.time.completed).toBeNumber()
      expect(SessionV1.AbortedError.isInstance(info.info.error)).toBe(true)

      const tools = info.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
      expect(tools).toHaveLength(2)
      for (const part of tools) {
        expect(part.state.status).toBe("error")
        if (part.state.status !== "error") continue
        expect(part.state.metadata?.interrupted).toBe(true)
        expect(part.state.error).toBe(SessionRecovery.INTERRUPTED_TOOL)
      }
      const running = tools.find((part) => part.callID === "call-running")!
      if (running.state.status === "error") {
        expect(running.state.metadata?.output).toBe("half")
        expect(running.state.time.start).toBe(1)
      }
      // The empty reasoning fragment is dropped; the partial text is closed.
      expect(info.parts.some((part) => part.id === left.reasoning.id)).toBe(false)
      const text = info.parts.find((part) => part.id === left.text.id)
      expect(text?.type === "text" && text.time?.end).toBeNumber()

      // Replaying the history for a follow-up message keeps the partial text
      // and pairs every tool call with a result.
      const model = {
        id: "test-model",
        providerID: "test",
        api: { id: "test-model", url: "", npm: "@ai-sdk/anthropic" },
        capabilities: { input: { image: false, pdf: false } },
        options: {},
      } as never
      const replay = yield* MessageV2.toModelMessagesEffect(messages, model)
      const assistant = replay.find((msg) => msg.role === "assistant")
      expect(assistant).toBeDefined()
      const tool = replay.find((msg) => msg.role === "tool")
      expect(Array.isArray(tool?.content) ? tool.content.length : 0).toBe(2)

      // Already settled runs are left alone on the next sweep.
      expect((yield* recovery.sweep(ctx.directory, Date.now() + 1000)).messages).toBe(0)
    }),
  )

  it.instance("leaves runs started by this process untouched", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const recovery = yield* SessionRecovery.Service
      const ctx = yield* InstanceState.context
      const chat = yield* session.create({})
      const left = yield* crashed(chat.id)

      const result = yield* recovery.sweep(ctx.directory, left.assistant.time.created - 1)
      expect(result).toEqual({ messages: 0, parts: 0 })
      const messages = yield* session.messages({ sessionID: chat.id })
      const info = messages.find((msg) => msg.info.id === left.assistant.id)!
      expect(info.info.role === "assistant" && info.info.time.completed).toBeUndefined()
    }),
  )

  it.instance("claims a directory only while no other live process owns it", () =>
    Effect.gen(function* () {
      const recovery = yield* SessionRecovery.Service
      const ctx = yield* InstanceState.context
      const file = SessionRecovery.ownerFile(ctx.directory)
      // The instance claimed the directory on first use.
      expect((yield* recovery.init()).owner).toBe(true)
      const owner = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      expect(owner.pid).toBe(process.pid)
      expect(owner.token).toBeString()
    }),
  )

  it.instance("reclaims a stale owner record with the same pid", () =>
    Effect.gen(function* () {
      const recovery = yield* SessionRecovery.Service
      const ctx = yield* InstanceState.context
      const file = SessionRecovery.ownerFile(ctx.directory)
      yield* Effect.promise(() =>
        fs.mkdir(path.dirname(file), { recursive: true }).then(() =>
          fs.writeFile(
            file,
            JSON.stringify({
              pid: process.pid,
              hostname: os.hostname(),
              boot: Date.now(),
              token: "stale-owner-token",
              directory: ctx.directory,
            }),
          ),
        ),
      )

      expect((yield* recovery.init()).owner).toBe(true)
      const owner = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      expect(owner.token).not.toBe("stale-owner-token")
    }),
  )
})
