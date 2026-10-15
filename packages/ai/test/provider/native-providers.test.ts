import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { LLM, ToolDefinition } from "../../src/index.js"
import {
  Anthropic,
  AnthropicCompatible,
  DeepSeek,
  OpenAICompatible,
} from "../../src/providers/index.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

describe("native providers", () => {
  test("assigns provider-owned metadata namespaces across native routes", () => {
    const providers = [
      [Anthropic.configure({ apiKey: "test" }).model("model"), "anthropic"],
      [
        AnthropicCompatible.configure({ baseURL: "https://example.test/v1", provider: "bailian" }).model("model"),
        "bailian",
      ],
      [OpenAICompatible.configure({ baseURL: "https://example.test/v1", provider: "custom" }).model("model"), "custom"],
      [DeepSeek.configure({ apiKey: "test" }).model("model"), "deepseek"],
    ] as const

    for (const [model, key] of providers) expect(model.route.providerMetadataKey).toBe(key)
  })

  it.effect("preserves DeepSeek Chat requests and identity through custom endpoints", () =>
    Effect.gen(function* () {
      const settings = {
        apiKey: "fixture",
        baseURL: "https://gateway.example/v1",
        reasoningEffort: "high",
      }
      const selected = DeepSeek.configure(settings).model("test-model")
      expect(selected.provider).toBe(DeepSeek.id)
      expect(selected.route.id).toBe(`${DeepSeek.id}-chat`)
      expect(selected.route.protocol).toBe("openai-chat")
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      const input = {
        prompt: "Use a tool.",
        generation: { maxTokens: 48 },
        tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
      }
      const native = yield* compileRequest(LLM.request({ ...input, model: selected }))
      const generic = yield* compileRequest(
        LLM.request({
          ...input,
          model: OpenAICompatible.configure({ ...settings, provider: DeepSeek.id }).model("test-model"),
        }),
      )
      expect(native.body).toEqual(generic.body)
    }),
  )

  it.effect("applies DeepSeek request defaults even with a custom gateway URL", () =>
    Effect.gen(function* () {
      const deepseek = yield* compileRequest(
        LLM.request({
          model: DeepSeek.configure({ apiKey: "fixture", baseURL: "https://gateway.example/v1" }).model(
            "deepseek-chat",
          ),
          prompt: "Use a tool.",
          generation: { maxTokens: 32 },
          tools: [
            ToolDefinition.make({ name: "lookup", description: "Look up data", inputSchema: { type: "object" } }),
          ],
          store: true,
        }),
      )

      expect(deepseek.body).toMatchObject({
        max_tokens: 32,
        stream_options: { include_usage: true },
        tools: [{ function: { name: "lookup" } }],
      })
      expect(deepseek.body).not.toHaveProperty("max_completion_tokens")
      expect(deepseek.body).not.toHaveProperty("store")
    }),
  )

  test("maps package settings onto native executable models", () => {
    const selected = DeepSeek.model("provider-model", {
      apiKey: "fixture",
      baseURL: "https://gateway.example/v1",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
      reasoningEffort: "high",
    })

    expect(selected.route.endpoint.baseURL).toBe("https://gateway.example/v1")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(selected.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
  })

  it.effect("resolves provider environment credentials", () =>
    Effect.gen(function* () {
      const scenarios = [
        {
          model: DeepSeek.configure().model("deepseek-chat"),
          env: { DEEPSEEK_API_KEY: "deepseek-secret" },
          token: "deepseek-secret",
          url: "https://api.deepseek.com/v1/chat/completions",
        },
      ]

      yield* Effect.forEach(scenarios, (scenario) =>
        LLM.generate(LLM.request({ model: scenario.model, prompt: "Say hello." })).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe(scenario.url)
                expect(request.headers.get("authorization")).toBe(`Bearer ${scenario.token}`)
                return input.respond(
                  sseEvents(
                    { id: "chatcmpl_fixture", choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
                    { id: "chatcmpl_fixture", choices: [{ delta: {}, finish_reason: "stop" }] },
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }),
            ),
          ),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: scenario.env }))),
          Effect.tap((response) => Effect.sync(() => expect(response.text).toBe("Hello"))),
        ),
      )
    }),
  )
})
