import { describe, expect, test } from "bun:test"
import { AISDKNative } from "@opencode/core/aisdk-native"

function map(
  packageName: string,
  settings: Readonly<Record<string, unknown>>,
  modelID = "test-model",
  providerID = "test-provider",
) {
  const target: {
    package?: string
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    body?: Record<string, unknown>
  } = {
    package: `aisdk:${packageName}`,
    settings: { ...settings },
  }
  AISDKNative.rewrite(target, { specifier: target.package, providerID, modelID })
  return target.package?.startsWith("aisdk:") ? undefined : target
}

describe("AISDKNative", () => {
  test("maps the generic OpenAI-compatible package and records the provider", () => {
    expect(map("@ai-sdk/openai-compatible", { baseURL: "https://example.com/v1", reasoningEffort: "high" })).toEqual({
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "https://example.com/v1",
        provider: "test-provider",
        reasoningEffort: "high",
      },
    })
  })

  test("maps Anthropic settings and request options to the native provider", () => {
    expect(
      map("@ai-sdk/anthropic", {
        authToken: "token",
        baseURL: "https://anthropic.example/v1",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      }),
    ).toEqual({
      package: "@opencode/ai/providers/anthropic",
      settings: {
        authToken: "token",
        baseURL: "https://anthropic.example/v1",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    })
  })

  test("moves headers and extraBody out of settings into overlays", () => {
    expect(
      map("@ai-sdk/openai-compatible", {
        apiKey: "secret",
        baseURL: "https://example.com/v1",
        headers: { "x-provider": "test" },
        extraBody: { custom: { enabled: true } },
      }),
    ).toEqual({
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "secret", baseURL: "https://example.com/v1", provider: "test-provider" },
      headers: { "x-provider": "test" },
      body: { custom: { enabled: true } },
    })
  })

  test("routes the supported vendor to its dedicated package by provider id", () => {
    expect(AISDKNative.native("@ai-sdk/openai-compatible", { providerID: "deepseek" })).toBe(
      "@opencode/ai/providers/deepseek",
    )
    // The same npm on a provider with no host row falls back to the generic facade.
    expect(AISDKNative.native("@ai-sdk/openai-compatible", { providerID: "deepseek-labs" })).toBe(
      "@opencode/ai/providers/openai-compatible",
    )
  })

  test("sends declared Anthropic-protocol providers to the Anthropic package", () => {
    expect(AISDKNative.native("@ai-sdk/anthropic", { providerID: "bailian-token-plan-personal" })).toBe(
      "@opencode/ai/providers/anthropic",
    )
  })

  test("leaves packages of unsupported vendors to the generic AI SDK bridge", () => {
    for (const npm of [
      "@ai-sdk/openai",
      "@ai-sdk/google",
      "@ai-sdk/amazon-bedrock",
      "@ai-sdk/alibaba",
      "@openrouter/ai-sdk-provider",
    ]) {
      expect(AISDKNative.native(npm, { providerID: "anything" })).toBeUndefined()
      expect(map(npm, { apiKey: "secret" })).toBeUndefined()
    }
  })
})
