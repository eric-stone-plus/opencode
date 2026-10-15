import { describe, expect, test } from "bun:test"
import { ModelsDev } from "../src/models-dev.js"

describe("ModelsDev.restrict", () => {
  test("keeps DeepSeek and its prefixed variants, and nothing else", () => {
    const registry = Object.fromEntries(["deepseek", "deepseek-cn"].map((id) => [id, { id }]))
    expect(Object.keys(ModelsDev.restrict(registry))).toEqual(Object.keys(registry))
  })

  test("drops every other provider, including every Alibaba and Xiaomi entry", () => {
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
        "alibaba",
        "alibaba-cn",
        "alibaba-coding-plan",
        "alibaba-coding-plan-cn",
        "alibaba-token-plan",
        "alibaba-token-plan-cn",
        "alibabacloud",
        "xiaomi",
        "xiaomi-token-plan-cn",
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
