import { describe, expect, test } from "bun:test"
import { LLM } from "../src/index.js"
import { Endpoint } from "../src/route/endpoint.js"

const configuration = (provider: string, message: string) =>
  expect.objectContaining({ _tag: "ProviderConfiguration", provider, message })

describe("provider package entrypoints", () => {
  test("maps Alibaba API entrypoints onto explicit regional routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/alibaba"),
      import("@opencode/ai/providers/alibaba/chat"),
      import("@opencode/ai/providers/alibaba/messages"),
    ])
    const settings = {
      region: "eu-central-1",
      workspaceID: "llm-fixture",
      apiKey: "fixture",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    const routes = ["alibaba-chat", "alibaba-chat", "alibaba-messages"]
    modules.forEach((module, index) => {
      const model = module.model("qwen3.8-max", settings)
      expect(model.provider).toBe("alibaba")
      expect(model.route.id).toBe(routes[index])
      expect(model.route.endpoint.baseURL).toBe(
        `https://llm-fixture.eu-central-1.maas.aliyuncs.com/${index === 2 ? "apps/anthropic/v1" : "compatible-mode/v1"}`,
      )
      expect(model.route.defaults.headers).toEqual(settings.headers)
      expect(model.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps ZAI and Coding Plan entrypoints onto distinct provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/zai"),
      import("@opencode/ai/providers/zai/chat"),
      import("@opencode/ai/providers/zai-coding-plan"),
      import("@opencode/ai/providers/zai-coding-plan/chat"),
      import("@opencode/ai/providers/zai-coding-plan/messages"),
    ])
    const routes = ["zai-chat", "zai-chat", "zai-coding-chat", "zai-coding-chat", "zai-coding-messages"]
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/custom",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    modules.forEach((module, index) => {
      const selected = module.model("glm-5.3", settings)
      expect(selected.provider).toBe(index < 2 ? "zai" : "zai-coding-plan")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps package settings onto the executable model", async () => {
    const OpenAICompatible = await import("@opencode/ai/providers/openai-compatible")
    const selected = OpenAICompatible.model("deepseek-chat", {
      apiKey: "fixture",
      baseURL: "https://api.deepseek.test/v1",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
      unrelatedInheritedSetting: true,
    })

    expect(selected.route.id).toBe("openai-compatible-chat")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
  })

  test("maps Anthropic-compatible settings onto the executable model", async () => {
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    const selected = AnthropicCompatible.model("compatible-model", {
      apiKey: "fixture",
      baseURL: "https://messages.example.test/v1",
      provider: "example",
      headers: { "x-application": "opencode" },
      body: { metadata: { user_id: "user_1" } },
      effort: "low",
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("anthropic-compatible-messages")
    expect(selected.route.protocol).toBe("anthropic-messages")
    expect(selected.route.providerMetadataKey).toBe("example")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://messages.example.test/v1",
    })
    expect(
      Endpoint.render(selected.route.endpoint, { request: LLM.request({ model: selected }), body: {} }).toString(),
    ).toBe("https://messages.example.test/v1/messages")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ metadata: { user_id: "user_1" } })
    expect(selected.route.defaults.providerOptions).toEqual({ effort: "low" })
  })

  test("maps Anthropic provider options onto the executable model", async () => {
    const Anthropic = await import("@opencode/ai/providers/anthropic")
    const selected = Anthropic.model("claude-sonnet-4-6", {
      apiKey: "fixture",
      thinking: { type: "adaptive" },
    })

    expect(selected.route.id).toBe("anthropic-messages")
    expect(selected.route.defaults.providerOptions).toEqual({ thinking: { type: "adaptive" } })
  })

  test("requires an Anthropic-compatible base URL at runtime", async () => {
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally bypasses static required-option checks.
      Reflect.apply(AnthropicCompatible.model, undefined, ["compatible-model", { apiKey: "fixture" }]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible providers require a baseURL"))
  })

  test("rejects conflicting Anthropic-compatible auth settings at runtime", async () => {
    const Anthropic = await import("@opencode/ai/providers/anthropic")
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
      Reflect.apply(AnthropicCompatible.model, undefined, [
        "compatible-model",
        {
          apiKey: "fixture",
          authToken: "token",
          baseURL: "https://messages.example.test/v1",
        },
      ]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible apiKey cannot be combined with authToken"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
      Reflect.apply(Anthropic.model, undefined, ["claude-sonnet-4-6", { apiKey: "fixture", authToken: "token" }]),
    ).toThrow(configuration("anthropic", "Anthropic apiKey cannot be combined with authToken"))
  })
})
