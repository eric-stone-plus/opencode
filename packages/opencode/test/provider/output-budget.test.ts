import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isOverflow, usable } from "@/session/overflow"

const model: Provider.Model = {
  id: ModelV2.ID.make("qwen3.8-max"),
  providerID: ProviderV2.ID.make("bailian-token-plan-personal"),
  name: "Qwen3.8 Max",
  api: { id: "qwen3.8-max", npm: "@ai-sdk/anthropic", url: "https://example.invalid/v1" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 983616, input: 852544, output: 131072 },
  options: { effort: "max", maxOutputTokens: 65536 },
  headers: {},
  release_date: "",
  status: "active",
}

describe("model output budget", () => {
  test("uses a persistent per-model budget without an inherited environment override", () => {
    expect(ProviderTransform.maxOutputTokens(model)).toBe(65536)
    expect(ProviderTransform.maxOutputTokens(model, 32768)).toBe(32768)
    expect(ProviderTransform.maxOutputTokens({ ...model, options: { maxOutputTokens: 262144 } })).toBe(131072)
    expect(ProviderTransform.maxOutputTokens({ ...model, limit: { ...model.limit, output: 8192 } })).toBe(8192)
  })

  test("rejects invalid config budgets and preserves the default for other models", () => {
    for (const value of [undefined, null, "131072", 0, -1, 1.5, Infinity, NaN]) {
      expect(ProviderTransform.maxOutputTokens({ ...model, options: { maxOutputTokens: value } })).toBe(32000)
    }
  })

  test("keeps the 256k compaction window when increasing the Qwen output cap", () => {
    expect(usable({ cfg: {}, model })).toBe(236000)
  })

  test("counts separately recorded reasoning tokens when the provider omits total usage", () => {
    const tokens = { input: 180000, output: 5000, reasoning: 35000, cache: { read: 15000, write: 5000 } }
    expect(isOverflow({ cfg: {}, model, tokens })).toBe(true)
    expect(isOverflow({ cfg: {}, model, tokens: { ...tokens, reasoning: 0 } })).toBe(false)
    expect(isOverflow({ cfg: {}, model, tokens: { ...tokens, total: 220000 } })).toBe(false)
  })
})
