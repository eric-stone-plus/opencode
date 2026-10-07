import { describe, expect, test } from "bun:test"
import { Pricing } from "@opencode-ai/core/pricing"
import { Usage } from "@opencode-ai/llm"
import { getUsage } from "@/session/session"
import type { Provider } from "@/provider/provider"

// Session.getUsage (the recording path) and Pricing.costOf (the backfill /
// v2 step path) must price identical tokens identically — otherwise backfill
// and live sessions disagree for the same rates. Compare exactly (max abs
// diff 0): both sides run the same Decimal.js arithmetic.

const model = (cost: Pricing.Rates) => ({ cost }) as unknown as Provider.Model

type UsageInput = NonNullable<ConstructorParameters<typeof Usage>[0]>

const cases: ReadonlyArray<{ name: string; cost: Pricing.Rates; usage: UsageInput }> = [
  {
    name: "flat rates",
    cost: { input: 2, output: 6, cache: { read: 0.25, write: 2.5 } },
    usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
  },
  {
    name: "cache-heavy usage",
    cost: { input: 2, output: 6, cache: { read: 0.25, write: 2.5 } },
    usage: { inputTokens: 50_000, outputTokens: 300, reasoningTokens: 0, cacheReadInputTokens: 30_000, cacheWriteInputTokens: 19_700 },
  },
  {
    name: "tiered rates below the tier",
    cost: {
      input: 2,
      output: 6,
      cache: { read: 0.25, write: 2.5 },
      tiers: [{ input: 0.5, output: 1, cache: { read: 0.05, write: 0.1 }, tier: { type: "context", size: 128_000 } }],
    },
    usage: { inputTokens: 100_000, outputTokens: 10, reasoningTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  },
  {
    name: "tiered rates above the tier",
    cost: {
      input: 2,
      output: 6,
      cache: { read: 0.25, write: 2.5 },
      tiers: [{ input: 0.5, output: 1, cache: { read: 0.05, write: 0.1 }, tier: { type: "context", size: 128_000 } }],
    },
    usage: { inputTokens: 200_000, outputTokens: 100, reasoningTokens: 20, cacheReadInputTokens: 10_000, cacheWriteInputTokens: 0 },
  },
  {
    name: "over-200k rates above the threshold",
    cost: {
      input: 1,
      output: 2,
      cache: { read: 0.1, write: 0.2 },
      experimentalOver200K: { input: 0.4, output: 0.8, cache: { read: 0.04, write: 0.08 } },
    },
    usage: { inputTokens: 250_000, outputTokens: 10, reasoningTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  },
  {
    name: "over-200k rates below the threshold",
    cost: {
      input: 1,
      output: 2,
      cache: { read: 0.1, write: 0.2 },
      experimentalOver200K: { input: 0.4, output: 0.8, cache: { read: 0.04, write: 0.08 } },
    },
    usage: { inputTokens: 150_000, outputTokens: 10, reasoningTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  },
  {
    name: "zero rates",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
  },
  {
    name: "no usage fields",
    cost: { input: 2, output: 6, cache: { read: 0.25, write: 2.5 } },
    usage: {},
  },
]

describe("Session.getUsage vs Pricing.costOf parity", () => {
  for (const item of cases) {
    test(item.name, () => {
      const usage = new Usage(item.usage)
      const rawInput = item.usage.inputTokens ?? 0
      const result = getUsage({ model: model(item.cost), usage })
      const expected = Pricing.costOf(item.cost, result.tokens, rawInput)
      expect(result.cost).toBe(expected)
      expect(Math.abs(result.cost - expected)).toBe(0)
    })
  }
})
