import { describe, expect, test } from "bun:test"
import { ConfigProviderOptionsV1 } from "@opencode-ai/core/v1/config/provider-options"

describe("ConfigProviderOptionsV1", () => {
  test("keeps raw provider and request options unchanged", () => {
    const lowerer = ConfigProviderOptionsV1.get("custom-provider")

    expect(lowerer.provider({ apiKey: "secret", headers: { "x-test": "1" }, nested: { camelCase: true } })).toEqual({
      body: { apiKey: "secret", headers: { "x-test": "1" }, nested: { camelCase: true } },
    })
    expect(lowerer.request({ nested: { camelCase: true } })).toEqual({ nested: { camelCase: true } })
  })

  test("falls back to raw lowering for prototype property package names", () => {
    expect(ConfigProviderOptionsV1.get("toString").provider({ enabled: true })).toEqual({ body: { enabled: true } })
  })

  test("lowers Anthropic provider and request options", () => {
    const lowerer = ConfigProviderOptionsV1.get("@ai-sdk/anthropic")

    expect(
      lowerer.provider({
        apiKey: "secret",
        authToken: "token",
        baseURL: "https://anthropic.example",
        headers: { "x-test": "1" },
        body: { beta: true },
        generateId: "custom",
      }),
    ).toEqual({
      url: "https://anthropic.example",
      headers: { "x-api-key": "secret", Authorization: "Bearer token", "x-test": "1" },
      body: { beta: true },
      settings: { generateId: "custom" },
    })
    expect(
      lowerer.request({
        effort: "high",
        taskBudget: 1024,
        metadata: { userId: "user", traceId: "trace" },
        nestedValue: { camelCase: true },
      }),
    ).toEqual({
      output_config: { effort: "high", task_budget: 1024 },
      metadata: { user_id: "user", trace_id: "trace" },
      nested_value: { camel_case: true },
    })
  })

  test("lowers OpenAI-compatible provider and request options", () => {
    const lowerer = ConfigProviderOptionsV1.get("@ai-sdk/openai-compatible")

    expect(
      lowerer.provider({
        baseURL: "https://compatible.example/v1",
        headers: { "x-test": "1" },
        body: { trace: true },
        apiKey: "secret",
      }),
    ).toEqual({
      url: "https://compatible.example/v1",
      headers: { "x-test": "1" },
      body: { trace: true },
      settings: { apiKey: "secret" },
    })
    expect(lowerer.request({ reasoningEffort: "high", serviceTier: "priority" })).toEqual({
      reasoning_effort: "high",
      serviceTier: "priority",
    })
  })
})
