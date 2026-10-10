import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Pricing } from "@opencode-ai/core/pricing"
import { LLMEvent } from "@opencode-ai/llm"
import { Permission } from "@/permission"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor applies the configured retry budget", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // Default policy would retry both; max_attempts: 1 stops after one retry.
        yield* llm.error(503, { error: "boom" })
        yield* llm.error(503, { error: "boom" })
        yield* llm.text("unreachable")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toMatchObject({ name: "APIError" })
      }),
    { config: (url) => ({ ...providerCfg(url), retry: { max_attempts: 1 } }) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor does not replay completed tools after a stream failure", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        const release = defer<void>()
        const response = reply().tool("lookup", { query: "weather" }).item()
        if (response.type !== "sse") throw new Error("expected stream response")
        yield* llm.push(
          raw({
            head: [...response.head, ...response.tail.slice(0, -1)],
            wait: release.promise,
            tail: [{ error: { type: "server_error", message: "connection lost" } }],
          }),
        )
        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        let calls = 0
        const fiber = yield* handle
          .process({
            user: parent,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool" }],
            tools: {
              lookup: tool({
                description: "Look up information",
                inputSchema: z.object({ query: z.string() }),
                execute: async (input) => {
                  calls += 1
                  return { title: "Lookup", output: `result:${input.query}`, metadata: {} }
                },
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part) => part.type === "tool" && part.state.status === "completed")),
            Effect.provideService(Database.Service, database),
          ),
          "tool did not complete before the stream failed",
        )
        release.resolve()
        const value = yield* Fiber.join(fiber)
        const parts = yield* MessageV2.parts(msg.id)

        expect(calls).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(value).toBe("stop")
        expect(handle.message.error).toMatchObject({
          name: "APIError",
          data: { message: expect.stringContaining("not retried because a tool had already started"), isRetryable: false },
        })
        expect(parts.filter((part) => part.type === "tool")).toHaveLength(1)
        expect(parts.find((part) => part.type === "tool")?.state.status).toBe("completed")

        const messages = yield* MessageV2.toModelMessagesEffect(
          [
            yield* MessageV2.get({ sessionID: chat.id, messageID: parent.id }),
            yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id }),
          ],
          mdl,
        )
        expect(messages).toContainEqual({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              output: { type: "text", value: "result:weather" },
            },
          ],
        })

        // A fresh turn includes the saved result and may retry its own request.
        yield* llm.reset
        yield* llm.error(503, { error: "server unavailable" })
        yield* llm.text("continued from saved result")
        const next = yield* processors.create({
          assistantMessage: yield* assistant(chat.id, parent.id, path.resolve(dir)),
          sessionID: chat.id,
          model: mdl,
        })
        const resumed = yield* next.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages,
          tools: {},
        })
        expect(resumed).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(calls).toBe(1)
        expect(next.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor does not replay tools still running when a stream fails", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const started = defer<void>()
        const aborted = defer<void>()
        const response = reply().tool("lookup", { query: "weather" }).item()
        if (response.type !== "sse") throw new Error("expected stream response")
        yield* llm.push(
          raw({
            head: [...response.head, ...response.tail.slice(0, -1)],
            wait: started.promise,
            tail: [{ error: { type: "server_error", message: "connection lost" } }],
          }),
        )
        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        let calls = 0
        const value = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (_, options) => {
                calls += 1
                options.abortSignal!.addEventListener("abort", () => aborted.resolve(), { once: true })
                started.resolve()
                await aborted.promise
                return { title: "Lookup", output: "result", metadata: {} }
              },
            }),
          },
        })

        yield* Effect.promise(() => aborted.promise)
        const parts = yield* MessageV2.parts(msg.id)
        expect(calls).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(value).toBe("stop")
        expect(handle.message.error).toMatchObject({
          name: "APIError",
          data: { message: expect.stringContaining("not retried because a tool had already started"), isRetryable: false },
        })
        expect(parts.filter((part) => part.type === "tool")).toHaveLength(1)
        expect(parts.find((part) => part.type === "tool")?.state.status).toBe("error")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Stream idle timeout and non-interactive doom loop
// ---------------------------------------------------------------------------

// Emits a text delta, then stalls until `release` resolves: a stream kept
// alive by keep-alive pings that never carry an event. `tool` (when set) is
// called with the tools so a test can run one mid-stream.
function stallingLLM(opts: { tool?: (tools: LLM.StreamInput["tools"]) => Promise<unknown> }) {
  const state = { calls: 0 }
  const layer = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: (input) => {
        state.calls++
        const call = state.calls
        if (call > 1)
          return Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-2" }),
            LLMEvent.textDelta({ id: "text-2", text: "recovered" }),
            LLMEvent.textEnd({ id: "text-2" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        const tool = opts.tool
        return Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })).pipe(
          Stream.concat(
            tool
              ? Stream.fromEffect(Effect.promise(() => tool(input.tools))).pipe(
                  Stream.flatMap(() =>
                    Stream.make(
                      LLMEvent.textDelta({ id: "text-1", text: "after tool" }),
                      LLMEvent.textEnd({ id: "text-1" }),
                      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                      LLMEvent.finish({ reason: "stop" }),
                    ),
                  ),
                )
              : Stream.never,
          ),
        )
      },
    }),
  )
  return { state, layer }
}

const idleCfg = (idleTimeout: number) => ({
  ...cfg,
  provider: { test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, idleTimeout } } },
})

const streamInput = (
  chat: { id: SessionID },
  parent: SessionV1.User,
  mdl: Provider.Model,
  extra?: Partial<LLM.StreamInput>,
) =>
  ({
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: "hi" }],
    tools: {},
    ...extra,
  }) satisfies LLM.StreamInput

const stalled = stallingLLM({})
const itStalled = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, stalled.layer]]))

itStalled.live("session.processor aborts a silent stream after the idle timeout and retries it", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const statuses: string[] = []
        const events = yield* EventV2Bridge.Service
        const off = yield* events.listen((event) => {
          if (event.type === SessionStatus.Event.Status.type) {
            const data = event.data as { status: { type: string; message?: string } }
            if (data.status.type === "retry") statuses.push(data.status.message ?? "")
          }
          return Effect.void
        })

        const result = yield* handle.process(streamInput(chat, parent, mdl))
        yield* off

        expect(result).toBe("continue")
        expect(stalled.state.calls).toBe(2)
        expect(statuses.some((message) => message.includes("stream idle timeout"))).toBe(true)
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { config: idleCfg(200) },
  ),
)

const slowTool = stallingLLM({
  tool: (tools) => tools.slow!.execute!({}, { toolCallId: "call-slow", messages: [] }) as Promise<unknown>,
})
const itSlowTool = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, slowTool.layer]]))

itSlowTool.live("session.processor does not count tool execution time as stream idle time", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const slow = tool({
          description: "slow",
          inputSchema: z.object({}),
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 600))
            return "done"
          },
        })

        const result = yield* handle.process(streamInput(chat, parent, mdl, { tools: { slow } }))

        expect(result).toBe("continue")
        expect(slowTool.state.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "after tool")).toBe(true)
      }),
    { config: idleCfg(200) },
  ),
)

// Calls the `repeat` tool with identical input `count` times within one stream.
function repeatingLLM(count: number) {
  const results: Array<{ ok: boolean; message: string }> = []
  const layer = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: (input) =>
        Stream.fromEffect(
          Effect.promise(async () => {
            for (let i = 0; i < count; i++) {
              const out = await Promise.resolve(
                input.tools.repeat!.execute!({ path: "a" }, { toolCallId: `call-${i}`, messages: [] }),
              ).then(
                (value) => ({ ok: true, message: String(value) }),
                (error: Error) => ({ ok: false, message: error.message }),
              )
              results.push(out)
            }
          }),
        ).pipe(
          Stream.flatMap(() =>
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ),
          ),
        ),
    }),
  )
  return { results, layer }
}

const repeatTool = tool({
  description: "repeat",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => "same",
})
const unattended = (): Agent.Info => ({
  ...agent(),
  name: "auto",
  permission: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "deny" },
  ],
})

const warned = repeatingLLM(4)
const itWarned = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, warned.layer]]))

itWarned.live("session.processor returns a tool error to an unattended agent repeating an identical call", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process(
          streamInput(chat, parent, mdl, { agent: unattended(), tools: { repeat: repeatTool } }),
        )

        expect(warned.results.map((item) => item.ok)).toEqual([true, true, false, false])
        expect(warned.results[2]!.message).toContain("identical input 3 times")
        expect(result).toBe("continue")
        expect(handle.message.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

const onePerTurn = repeatingLLM(1)
const itOnePerTurn = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, onePerTurn.layer]]))

itOnePerTurn.live("session.processor resets doom-loop streaks for a new user turn", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        for (let i = 0; i < 3; i++) {
          const parent = yield* user(chat.id, `turn ${i}`)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          const result = yield* handle.process(
            streamInput(chat, parent, mdl, { agent: unattended(), tools: { repeat: repeatTool } }),
          )
          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }

        expect(onePerTurn.results.map((item) => item.ok)).toEqual([true, true, true])
      }),
    { config: cfg },
  ),
)

const stopped = repeatingLLM(6)
const itStopped = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, stopped.layer]]))

itStopped.live("session.processor stops an unattended agent that keeps repeating after the warning", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process(
          streamInput(chat, parent, mdl, { agent: unattended(), tools: { repeat: repeatTool } }),
        )

        expect(result).toBe("stop")
        expect(JSON.stringify(handle.message.error)).toContain("doom loop")
      }),
    { config: cfg },
  ),
)

// Interactive doom-loop detection: identical tool calls interleaved with
// step-start/text parts must still trigger the doom_loop ask. The old window
// `parts.slice(-3)` counted those interleaved parts, so `every()` failed and
// sequential repeats slipped through.
const doomAsks: string[] = []
const recordingPermission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) =>
      Effect.sync(() => {
        if (input.permission === "doom_loop") doomAsks.push(String(input.patterns?.[0] ?? ""))
      }),
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const interactiveDoomLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-0" }),
        LLMEvent.textDelta({ id: "text-0", text: "looking" }),
        LLMEvent.textEnd({ id: "text-0" }),
        LLMEvent.toolCall({ id: "call-0", name: "repeat", input: { path: "a" }, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-0",
          name: "repeat",
          result: { type: "text", value: "same" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.stepStart({ index: 1 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "looking again" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.toolCall({ id: "call-1", name: "repeat", input: { path: "a" }, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "repeat",
          result: { type: "text", value: "same" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 1, reason: "tool-calls" }),
        LLMEvent.stepStart({ index: 2 }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-2", text: "looking a third time" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.toolCall({ id: "call-2", name: "repeat", input: { path: "a" }, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-2",
          name: "repeat",
          result: { type: "text", value: "same" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 2, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const interactiveDoomEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, interactiveDoomLLM],
  [Permission.node, recordingPermission],
])
const itInteractiveDoom = testEffect(interactiveDoomEnv)

itInteractiveDoom.live("session.processor asks doom_loop for identical calls interleaved with step starts", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        doomAsks.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process(
          streamInput(chat, parent, mdl, { agent: agent(), tools: { repeat: repeatTool } }),
        )

        expect(result).toBe("continue")
        expect(handle.message.error).toBeUndefined()
        expect(doomAsks).toEqual(["repeat"])
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Auto price match gate: only a zero-rate model with a nonzero step may
// resolve prices; nanoAiu billing always wins.
// ---------------------------------------------------------------------------

const pricingCalls: Array<{ providerID: string; modelID: string }> = []
const matched: Pricing.Match = {
  cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
  source: "cross-provider",
}
const countingPricing = Layer.succeed(
  Pricing.Service,
  Pricing.Service.of({
    resolve: (input: { providerID: string; modelID: string }) =>
      Effect.sync(() => {
        pricingCalls.push(input)
        return matched
      }),
  }),
)

const stepFinishLLM = (
  usage: Record<string, number> | undefined,
  providerMetadata?: Record<string, Record<string, unknown>>,
) =>
  Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () =>
        Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "hi" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage, providerMetadata }),
          LLMEvent.finish({ reason: "stop" }),
        ),
    }),
  )

const zeroTokensLLM = stepFinishLLM({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
})
const itZeroTokens = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, zeroTokensLLM], [Pricing.node, countingPricing]]))

itZeroTokens.live("session.processor skips auto price match when the step used no tokens", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        pricingCalls.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process(streamInput(chat, parent, mdl))

        expect(result).toBe("continue")
        expect(pricingCalls).toHaveLength(0)
        const step = (yield* MessageV2.parts(msg.id)).find((part) => part.type === "step-finish")
        expect(step?.cost).toBe(0)
      }),
    { config: cfg },
  ),
)

const tokensLLM = stepFinishLLM({ inputTokens: 10, outputTokens: 4, reasoningTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })
const itTokens = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, tokensLLM], [Pricing.node, countingPricing]]))

itTokens.live("session.processor resolves and applies prices for a zero-rate model with tokens", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        pricingCalls.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process(streamInput(chat, parent, mdl))

        expect(result).toBe("continue")
        expect(pricingCalls).toEqual([{ providerID: ref.providerID, modelID: ref.modelID }])
        // (10*2 + 4*6) / 1e6 at the matched rates.
        const step = (yield* MessageV2.parts(msg.id)).find((part) => part.type === "step-finish")
        expect(step?.cost).toBeCloseTo(0.000044, 12)
      }),
    { config: cfg },
  ),
)

const nanoAiuLLM = stepFinishLLM(
  { inputTokens: 10, outputTokens: 4, reasoningTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  { copilot: { totalNanoAiu: 100_000_000_000 } },
)
const itNanoAiu = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, nanoAiuLLM], [Pricing.node, countingPricing]]))

itNanoAiu.live("session.processor keeps nanoAiu billing and never resolves rates for it", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        pricingCalls.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process(streamInput(chat, parent, mdl))

        expect(result).toBe("continue")
        expect(pricingCalls).toHaveLength(0)
        // 100_000_000_000 nanoAiu = $1.00.
        const step = (yield* MessageV2.parts(msg.id)).find((part) => part.type === "step-finish")
        expect(step?.cost).toBeCloseTo(1, 12)
      }),
    { config: cfg },
  ),
)
