import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, LLMRequest, Message, ToolDefinition, Media } from "../../src/index.js"
import { Alibaba } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { recordedTests } from "../recorded-test.js"

const alibaba = Alibaba.configure({ region: "ap-southeast-1", apiKey: process.env.ALIBABA_API_KEY ?? "fixture" })
const record = (api: "chat" | "messages") =>
  recordedTests({
    prefix: `alibaba-${api}`,
    provider: "alibaba",
    protocol: `alibaba-${api}`,
    requires: ["ALIBABA_API_KEY"],
    tags: ["region:ap-southeast-1"],
  })

for (const api of ["chat", "messages"] as const) {
  const recorded = record(api)
  describe(`Alibaba ${api} capabilities`, () => {
    for (const enabled of [false, true]) {
      recorded.effect.with(
        `Qwen 3.7 Plus streams thinking ${enabled ? "enabled" : "disabled"}`,
        { tags: ["thinking", "usage"] },
        () =>
          Effect.gen(function* () {
            const request = LLM.request({
              model: alibaba[api]("qwen3.7-plus"),
              providerOptions:
                api === "messages"
                  ? { thinking: { type: enabled ? "enabled" : "disabled", ...(enabled ? { budgetTokens: 1024 } : {}) } }
                  : api === "chat"
                    ? { enableThinking: enabled, ...(enabled ? { thinkingBudget: 1024 } : {}) }
                    : { enableThinking: enabled },
              prompt: "What is 173 multiplied by 219? Reply with only the final integer.",
              generation: { maxTokens: 4096 },
            })
            const compiled = yield* compileRequest(request)
            expect(api === "messages" ? compiled.body.thinking.type : compiled.body.enable_thinking).toBe(
              api === "messages" ? (enabled ? "enabled" : "disabled") : enabled,
            )
            const response = yield* LLMClient.generate(request)
            expect(response.text.replaceAll(",", "")).toContain("37887")
            expect(response.reasoning.length > 0).toBe(enabled)
            expect(response.finishReason.normalized).toBe("stop")
            expect(response.usage?.inputTokens).toBeGreaterThan(0)
            expect(response.usage?.outputTokens).toBeGreaterThan(0)
          }),
        120_000,
      )
    }
    recorded.effect.with(
      "Qwen 3.8 Flash reads image bytes",
      { tags: ["image"] },
      () =>
        Effect.gen(function* () {
          const bytes = yield* Effect.promise(() =>
            Bun.file(new URL("../fixtures/media/restroom.png", import.meta.url)).bytes(),
          )
          const response = yield* LLMClient.generate(
            LLM.request({
              model: alibaba[api]("qwen3.8-flash"),
              providerOptions: api === "messages" ? { thinking: { type: "disabled" } } : { enableThinking: false },
              messages: [
                Message.user([
                  { type: "text", text: "Read the three words in this image. Reply with only the words in order." },
                  { type: "media", media: Media.bytes(bytes, "image/png") },
                ]),
              ],
              generation: { maxTokens: 4096 },
            }),
          )
          expect(response.text.toLowerCase()).toContain("jiggling restroom prison")
          expect(response.finishReason.normalized).toBe("stop")
        }),
      120_000,
    )
    recorded.effect.with(
      "Qwen 3.8 Max obeys named tool choice",
      { tags: ["tool", "tool-choice"] },
      () =>
        Effect.gen(function* () {
          const response = yield* LLMClient.generate(
            LLM.request({
              model: alibaba[api]("qwen3.8-max"),
              prompt: "Find the current weather in Paris.",
              providerOptions: api === "messages" ? { thinking: { type: "disabled" } } : { reasoningEffort: "none" },
              tools: [
                ToolDefinition.make({
                  name: "get_weather",
                  description: "Get weather in a city",
                  inputSchema: {
                    type: "object",
                    properties: { city: { type: "string", enum: ["Paris"] } },
                    required: ["city"],
                  },
                }),
              ],
              toolChoice: { type: "tool", name: "get_weather" },
              generation: { maxTokens: 4096 },
            }),
          )
          expect(response.toolCalls).toMatchObject([{ name: "get_weather", input: { city: "Paris" } }])
          expect(response.finishReason.normalized).toBe(api === "messages" ? "stop" : "tool-calls")
          if (api === "messages") expect(response.finishReason.raw).toBe("end_turn")
        }),
      120_000,
    )
  })
}

record("chat").effect.with(
  "Qwen 3.8 Max returns a JSON object",
  { tags: ["structured-output"] },
  () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: alibaba.chat("qwen3.8-max"),
          prompt: 'Return a JSON object with one key "city" set to the capital city of France.',
          providerOptions: { reasoningEffort: "none", responseFormat: { type: "json_object" } },
          generation: { maxTokens: 1024 },
        }),
      )
      expect(JSON.parse(response.text)).toEqual({ city: "Paris" })
      expect(response.finishReason.normalized).toBe("stop")
    }),
  120_000,
)

record("messages").effect.with(
  "Qwen 3.8 Max follows a JSON schema",
  { tags: ["structured-output"] },
  () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: alibaba.messages("qwen3.8-max"),
          prompt: 'Return a JSON object with one key "city" set to the capital city of France.',
          providerOptions: {
            thinking: { type: "disabled" },
            outputConfig: {
              format: {
                type: "json_schema",
                schema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                  additionalProperties: false,
                },
              },
            },
          },
          generation: { maxTokens: 1024 },
        }),
      )
      expect(JSON.parse(response.text)).toEqual({ city: "Paris" })
      expect(response.finishReason.normalized).toBe("stop")
    }),
  120_000,
)
