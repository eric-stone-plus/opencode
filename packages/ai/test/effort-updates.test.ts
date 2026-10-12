import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart } from "../src/index.js"
import { Auth, LLMClient } from "../src/route.js"
import { compileRequest } from "../src/route/client.js"
import { AnthropicMessages } from "../src/protocols/anthropic-messages.js"
import { OpenAIChat } from "../src/protocols/openai-chat.js"
import { applyEffortUpdates } from "../src/effort-updates.js"
import { it, testEffect } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"

const anthropic = (id: string, compatibility?: { readonly supportsEffortUpdates?: boolean }) =>
  AnthropicMessages.route
    .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
    .model({ id, compatibility })

const opus5 = anthropic("claude-opus-5")

const lowFromHigh = Message.effort({ effort: "low", previous: "high" })
const conversation = [Message.user("Before."), lowFromHigh, Message.user("After.")]

const systemMessages = (body: AnthropicMessages.AnthropicMessagesBody) =>
  body.messages.filter((message) => message.role === "system")

describe("applyEffortUpdates", () => {
  test("keeps the request identity without markers and for protocols that lower them", () => {
    const plain = LLM.request({ model: opus5, prompt: "hi" })
    expect(applyEffortUpdates(plain)).toBe(plain)

    const supported = LLM.request({ model: opus5, messages: conversation, providerOptions: { effort: "low" } })
    expect(applyEffortUpdates(supported)).toBe(supported)
  })

  it.effect("compiles markers away for protocols without per-message effort", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const withMarkers = yield* compileRequest(LLM.request({ model, messages: conversation }))
      const withoutMarkers = yield* compileRequest(
        LLM.request({ model, messages: [Message.user("Before."), Message.user("After.")] }),
      )

      expect(withMarkers.body).toEqual(withoutMarkers.body)
    }),
  )
})

describe("cache policy", () => {
  it.effect("walks the tail breakpoint back past a trailing effort marker", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: opus5,
          messages: [Message.user("first"), Message.assistant("reply"), Message.user("latest"), lowFromHigh],
          providerOptions: { effort: "low" },
          cache: "auto",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "latest", cache_control: { type: "ephemeral" } }] },
        { role: "system", content: [], output_config: { effort: "low" } },
      ])
    }),
  )
})

describe("Anthropic Messages effort updates", () => {
  it.effect("lowers markers to per-turn system messages and freezes the top-level effort", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({ model: opus5, messages: conversation, providerOptions: { effort: "low" }, cache: "none" }),
      )

      expect(prepared.body.output_config).toEqual({ effort: "high" })
      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Before." }] },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "user", content: [{ type: "text", text: "After." }] },
      ])
    }),
  )

  it.effect("omits the frozen effort for the model default and sends `high` for a switch back to it", () =>
    Effect.gen(function* () {
      const format = { type: "json_schema" as const, schema: { type: "object" } }
      const prepared = yield* compileRequest(
        LLM.request({
          model: opus5,
          messages: [
            Message.user("One."),
            Message.effort({ effort: "low" }),
            Message.user("Two."),
            Message.effort({ previous: "low" }),
            Message.user("Three."),
          ],
          providerOptions: { output_config: { format } },
          cache: "none",
        }),
      )

      expect(prepared.body.output_config).toEqual({ format })
      expect(systemMessages(prepared.body)).toEqual([
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "system", content: [], output_config: { effort: "high" } },
      ])
    }),
  )

  it.effect("requests the mid-conversation output config beta only when markers are sent", () =>
    Effect.gen(function* () {
      for (const [model, expected] of [
        [opus5, true],
        [anthropic("claude-sonnet-5"), false],
      ] as const) {
        const request = LLM.request({
          model,
          messages: conversation,
          providerOptions: { effort: "low" },
          http: { headers: { "anthropic-beta": "existing-beta" } },
        })
        const compiled = yield* compileRequest(request)
        const prepared = yield* AnthropicMessages.route.prepareTransport(compiled.body, request)
        const betas = prepared.request.headers["anthropic-beta"]!.split(",")
        expect(betas).toContain("existing-beta")
        expect(betas.includes("mid-conversation-output-config-2026-07-01")).toBe(expected)
      }
    }),
  )

  it.effect("moves a marker between a tool call and its result after the result", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: opus5,
          messages: [
            Message.user("Weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            lowFromHigh,
            Message.tool({ id: "call_1", name: "lookup", result: { temp: 72 } }),
          ],
          providerOptions: { effort: "low" },
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Weather?" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temp":72}' }] },
        { role: "system", content: [], output_config: { effort: "low" } },
      ])
    }),
  )

  it.effect("releases a held system update next to an effort marker as one valid section", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: opus5,
          messages: [
            Message.user("Fix it."),
            Message.assistant("Done."),
            lowFromHigh,
            Message.system("Update."),
            Message.user("Next."),
          ],
          providerOptions: { effort: "low" },
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Fix it." }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "user", content: [{ type: "text", text: "Next." }] },
        { role: "system", content: [{ type: "text", text: "Update.", cache_control: undefined }] },
      ])
    }),
  )

  it.effect("falls back to a plain top-level effort when history drifted from the current effort", () =>
    Effect.gen(function* () {
      const drifted = yield* compileRequest(
        LLM.request({ model: opus5, messages: conversation, providerOptions: { effort: "medium" }, cache: "none" }),
      )
      const plain = yield* compileRequest(
        LLM.request({
          model: opus5,
          messages: [Message.user("Before."), Message.user("After.")],
          providerOptions: { effort: "medium" },
          cache: "none",
        }),
      )

      expect(drifted.body).toEqual(plain.body)
      expect(drifted.body.output_config).toEqual({ effort: "medium" })
    }),
  )

  for (const [id, supported] of [
    ["claude-opus-5", true],
    ["claude-opus-5-20260901", true],
    ["anthropic/claude-opus-5", true],
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", true],
    ["claude-opus-5-5", true],
    ["claude-sonnet-5-5", true],
    ["anthropic/claude-sonnet-5-5", true],
    ["claude-sonnet-6", true],
    ["claude-haiku-6", true],
    ["claude-fable-5", false],
    ["claude-opus-4-8", false],
    ["claude-sonnet-5", false],
    ["claude-sonnet-5-20260801", false],
    ["kimi-k2.5", false],
  ] as const) {
    it.effect(`${supported ? "lowers" : "strips"} markers for ${id}`, () =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(
          LLM.request({ model: anthropic(id), messages: conversation, providerOptions: { effort: "low" } }),
        )

        expect(systemMessages(prepared.body)).toHaveLength(supported ? 1 : 0)
        expect(prepared.body.output_config).toEqual({ effort: supported ? "high" : "low" })
      }),
    )
  }

  it.effect("honors the compatibility override in both directions", () =>
    Effect.gen(function* () {
      const enabled = yield* compileRequest(
        LLM.request({
          model: anthropic("claude-sonnet-5", { supportsEffortUpdates: true }),
          messages: conversation,
          providerOptions: { effort: "low" },
        }),
      )
      const disabled = yield* compileRequest(
        LLM.request({
          model: anthropic("claude-opus-5", { supportsEffortUpdates: false }),
          messages: conversation,
          providerOptions: { effort: "low" },
        }),
      )

      expect(systemMessages(enabled.body)).toHaveLength(1)
      expect(systemMessages(disabled.body)).toHaveLength(0)
    }),
  )

  it.effect("strips markers when thinking is disabled or between_tools", () =>
    Effect.gen(function* () {
      const sonnet = anthropic("claude-sonnet-5-5")
      const betweenTools = yield* compileRequest(
        LLM.request({
          model: sonnet,
          messages: conversation,
          providerOptions: { thinking: { type: "between_tools" }, effort: "low" },
        }),
      )

      expect(systemMessages(betweenTools.body)).toHaveLength(0)
      expect(betweenTools.body.output_config).toEqual({ effort: "low" })
    }),
  )
})
