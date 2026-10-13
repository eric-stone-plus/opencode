import { describe, expect, test } from "bun:test"
import { ModelsDev } from "../src/models-dev.js"

describe("ModelsDev.restrict", () => {
  test("keeps Alibaba and DeepSeek with their regional and plan variants, plus the one Xiaomi token plan", () => {
    const registry = Object.fromEntries(
      [
        "alibaba",
        "alibaba-cn",
        "alibaba-coding-plan-cn",
        "alibaba-token-plan",
        "deepseek",
        "xiaomi-token-plan-cn",
      ].map((id) => [id, { id }]),
    )
    expect(Object.keys(ModelsDev.restrict(registry))).toEqual(Object.keys(registry))
  })

  test("drops every other provider, including the other Xiaomi plans and lookalike prefixes", () => {
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
        "xiaomi",
        "xiaomi-token-plan-ams",
        "xiaomi-token-plan-sgp",
        "xiaomi2",
        "zai",
        "zai-coding-plan",
        "zhipuai",
        "zhipuai-coding-plan",
        "zaiextra",
      ].map((id) => [id, { id }]),
    )
    expect(ModelsDev.restrict(registry)).toEqual({})
  })

  test("returns the original provider values untouched", () => {
    const deepseek = { models: {} }
    expect(ModelsDev.restrict({ deepseek, openai: { models: {} } }).deepseek).toBe(deepseek)
  })
})
