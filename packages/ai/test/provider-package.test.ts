import { describe, expect, test } from "bun:test"
import { LLM } from "../src/index.js"
import { Endpoint } from "../src/route/endpoint.js"

const configuration = (provider: string, message: string) =>
  expect.objectContaining({ _tag: "ProviderConfiguration", provider, message })

describe("provider package entrypoints", () => {
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
