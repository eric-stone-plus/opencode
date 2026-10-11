import { describe, expect, test } from "bun:test"
import { ModelsDev } from "../src/models-dev"

describe("ModelsDev.restrict", () => {
  test("keeps the supported vendors with their regional and plan variants", () => {
    const registry = Object.fromEntries(
      [
        "alibaba",
        "alibaba-cn",
        "alibaba-coding-plan-cn",
        "alibaba-token-plan",
        "deepseek",
        "zhipuai",
        "zhipuai-coding-plan",
        "zai",
        "zai-coding-plan",
        "xiaomi",
        "xiaomi-token-plan-cn",
      ].map((id) => [id, { id }]),
    )
    expect(Object.keys(ModelsDev.restrict(registry))).toEqual(Object.keys(registry))
  })

  test("drops every other provider, including lookalike prefixes and the Zen providers", () => {
    const registry = Object.fromEntries(
      [
        "anthropic",
        "openai",
        "openrouter",
        "opencode",
        "opencode-go",
        "google",
        "moonshotai",
        "deepseekish",
        "alibabacloud",
        "zaiextra",
        "xiaomi2",
      ].map((id) => [id, { id }]),
    )
    expect(ModelsDev.restrict(registry)).toEqual({})
  })

  test("returns the original provider values untouched", () => {
    const deepseek = { models: {} }
    expect(ModelsDev.restrict({ deepseek, openai: { models: {} } }).deepseek).toBe(deepseek)
  })
})
