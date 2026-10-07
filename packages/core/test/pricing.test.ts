import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Pricing } from "@opencode-ai/core/pricing"
import { ModelsDev } from "@opencode-ai/core/models-dev"

const model = (input: {
  id: string
  cost?: ModelsDev.Model["cost"]
  canonical?: string
}): ModelsDev.Model => ({
  id: input.id,
  name: input.id,
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  ...(input.cost === undefined ? {} : { cost: input.cost }),
  ...(input.canonical === undefined ? {} : { canonical_model_id: input.canonical }),
})

const provider = (id: string, models: Record<string, ModelsDev.Model>): ModelsDev.Provider => ({
  id,
  name: id,
  env: [],
  models,
})

const zeroCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

// Mirrors the real models.dev shapes the fork cares about: token-plan providers
// declare explicit zero prices and point at their canonical list-price row.
const registry: Record<string, ModelsDev.Provider> = {
  "xiaomi-token-plan-cn": provider("xiaomi-token-plan-cn", {
    "mimo-v2.6-pro": model({ id: "mimo-v2.6-pro", cost: zeroCost, canonical: "xiaomi/mimo-v2.6-pro" }),
  }),
  xiaomi: provider("xiaomi", {
    "mimo-v2.6-pro": model({ id: "mimo-v2.6-pro", cost: { input: 0.435, output: 0.87, cache_read: 0.0036 } }),
  }),
  "zhipuai-coding-plan": provider("zhipuai-coding-plan", {
    "glm-5.3": model({ id: "glm-5.3", cost: zeroCost, canonical: "zhipuai/glm-5.3" }),
  }),
  zhipuai: provider("zhipuai", {
    "glm-5.3": model({
      id: "glm-5.3",
      cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      canonical: "zhipuai/glm-5.3",
    }),
  }),
  alibaba: provider("alibaba", {
    "qwen3.8-max": model({
      id: "qwen3.8-max",
      cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
      canonical: "alibaba/qwen3.8-max",
    }),
    "qwen3.8-max-preview": model({
      id: "qwen3.8-max-preview",
      cost: { input: 2.5, output: 7, cache_read: 0.3, cache_write: 3 },
    }),
  }),
  above: provider("above", {
    "qwen3.8-max": model({
      id: "qwen3.8-max",
      cost: { input: 2.2, output: 6.6, cache_read: 0.275 },
      canonical: "alibaba/qwen3.8-max",
    }),
  }),
  abacus: provider("abacus", {
    "qwen3.8-max": model({ id: "qwen3.8-max", cost: { input: 2, output: 6 }, canonical: "alibaba/qwen3.8-max" }),
  }),
  hyper: provider("hyper", {
    "qwen3.8-max": model({
      id: "qwen3.8-max",
      cost: { input: 2, output: 6, cache_read: 0.25 },
      canonical: "alibaba/qwen3.8-max-preview",
    }),
  }),
  "alibaba-token-plan": provider("alibaba-token-plan", {
    "qwen3.8-max": model({ id: "qwen3.8-max", cost: zeroCost, canonical: "alibaba/qwen3.8-max" }),
  }),
  opencode: provider("opencode", {
    "big-pickle": model({ id: "big-pickle", cost: zeroCost }),
  }),
}

describe("Pricing.match", () => {
  test("declared nonzero cost wins over canonical and cross-provider", () => {
    expect(Pricing.match(registry, { providerID: "zhipuai", modelID: "glm-5.3" })).toEqual({
      cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      source: "declared",
    })
    expect(Pricing.match(registry, { providerID: "xiaomi", modelID: "mimo-v2.6-pro" })).toEqual({
      cost: { input: 0.435, output: 0.87, cache_read: 0.0036 },
      source: "declared",
    })
  })

  test("zero cost resolves through canonical_model_id", () => {
    expect(Pricing.match(registry, { providerID: "xiaomi-token-plan-cn", modelID: "mimo-v2.6-pro" })).toEqual({
      cost: { input: 0.435, output: 0.87, cache_read: 0.0036 },
      source: "canonical",
    })
  })

  test("zero cost resolves to a self-canonical target row", () => {
    expect(Pricing.match(registry, { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" })).toEqual({
      cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      source: "canonical",
    })
  })

  test("canonical resolution follows the chain transitively within three hops", () => {
    const chain: Record<string, ModelsDev.Provider> = {
      a: provider("a", { hop: model({ id: "hop", cost: zeroCost, canonical: "b/hop" }) }),
      b: provider("b", { hop: model({ id: "hop", cost: zeroCost, canonical: "c/hop" }) }),
      c: provider("c", { hop: model({ id: "hop", cost: zeroCost, canonical: "d/hop" }) }),
      d: provider("d", { hop: model({ id: "hop", cost: { input: 3, output: 9 } }) }),
    }
    expect(Pricing.match(chain, { providerID: "a", modelID: "hop" })).toEqual({
      cost: { input: 3, output: 9 },
      source: "canonical",
    })
  })

  test("canonical resolution stops after three hops", () => {
    // Unique model ids per row so cross-provider matching cannot rescue the
    // match; only the 3-hop canonical walk is under test.
    const chain: Record<string, ModelsDev.Provider> = {
      a: provider("a", { "hop-a": model({ id: "hop-a", cost: zeroCost, canonical: "b/hop-b" }) }),
      b: provider("b", { "hop-b": model({ id: "hop-b", cost: zeroCost, canonical: "c/hop-c" }) }),
      c: provider("c", { "hop-c": model({ id: "hop-c", cost: zeroCost, canonical: "d/hop-d" }) }),
      d: provider("d", { "hop-d": model({ id: "hop-d", cost: zeroCost, canonical: "e/hop-e" }) }),
      e: provider("e", { "hop-e": model({ id: "hop-e", cost: { input: 3, output: 9 } }) }),
    }
    expect(Pricing.match(chain, { providerID: "a", modelID: "hop-a" })).toBeUndefined()
  })

  test("canonical cycles terminate without a match", () => {
    const chain: Record<string, ModelsDev.Provider> = {
      a: provider("a", { hop: model({ id: "hop", cost: zeroCost, canonical: "b/hop" }) }),
      b: provider("b", { hop: model({ id: "hop", cost: zeroCost, canonical: "a/hop" }) }),
    }
    expect(Pricing.match(chain, { providerID: "a", modelID: "hop" })).toBeUndefined()
  })

  test("cross-provider majority canonical wins for qwen3.8-max", () => {
    expect(Pricing.match(registry, { providerID: "bailian-token-plan-personal", modelID: "qwen3.8-max" })).toEqual({
      cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
      source: "cross-provider",
    })
  })

  test("cross-provider matches glm-5.3 for an absent provider", () => {
    expect(Pricing.match(registry, { providerID: "glm-coding-plan", modelID: "glm-5.3" })).toEqual({
      cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      source: "cross-provider",
    })
  })

  test("cross-provider falls back to the median-by-input of effective cost observations", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      m1: provider("m1", { "median-model": model({ id: "median-model", cost: { input: 10, output: 30 } }) }),
      m2: provider("m2", { "median-model": model({ id: "median-model", cost: { input: 1, output: 3 } }) }),
      m3: provider("m3", { "median-model": model({ id: "median-model", cost: { input: 2, output: 6 } }) }),
    }
    expect(Pricing.match(spread, { providerID: "other", modelID: "median-model" })).toEqual({
      cost: { input: 2, output: 6 },
      source: "cross-provider",
    })
  })

  test("cross-provider median takes the lower middle on an even number of observations", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      m1: provider("m1", { "median-model": model({ id: "median-model", cost: { input: 10, output: 30 } }) }),
      m2: provider("m2", { "median-model": model({ id: "median-model", cost: { input: 1, output: 3 } }) }),
      m3: provider("m3", { "median-model": model({ id: "median-model", cost: { input: 2, output: 6 } }) }),
      m4: provider("m4", { "median-model": model({ id: "median-model", cost: { input: 5, output: 15 } }) }),
    }
    expect(Pricing.match(spread, { providerID: "other", modelID: "median-model" })).toEqual({
      cost: { input: 2, output: 6 },
      source: "cross-provider",
    })
  })

  test("cross-provider model ids match case-insensitively when no exact row exists", () => {
    expect(Pricing.match(registry, { providerID: "acme", modelID: "GLM-5.3" })).toEqual({
      cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
      source: "cross-provider",
    })
  })

  test("explicit zero without any match stays unpriced", () => {
    expect(Pricing.match(registry, { providerID: "opencode", modelID: "big-pickle" })).toBeUndefined()
    expect(Pricing.match(registry, { providerID: "missing", modelID: "nothing" })).toBeUndefined()
  })

  test("cross-provider median counts duplicate observations instead of deduplicating costs", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      m1: provider("m1", { "median-model": model({ id: "median-model", cost: { input: 100, output: 300 } }) }),
      m2: provider("m2", { "median-model": model({ id: "median-model", cost: { input: 100, output: 300 } }) }),
      m3: provider("m3", { "median-model": model({ id: "median-model", cost: { input: 1, output: 3 } }) }),
    }
    // Median of the observations [100, 100, 1] is 100. Deduplicating identical
    // cost objects would collapse the two 100 rows and return the outlier 1.
    expect(Pricing.match(spread, { providerID: "other", modelID: "median-model" })).toEqual({
      cost: { input: 100, output: 300 },
      source: "cross-provider",
    })
  })

  test("all-zero exact rows do not shadow priced case-variant rows", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      p1: provider("p1", { Foo: model({ id: "Foo", cost: { input: 5, output: 15 } }) }),
      p2: provider("p2", { foo: model({ id: "foo", cost: zeroCost }) }),
    }
    // The exact candidates (p2/foo @0) price to nothing, so the
    // case-insensitive pass may fall through to the priced p1/Foo row.
    expect(Pricing.match(spread, { providerID: "p2", modelID: "foo" })).toEqual({
      cost: { input: 5, output: 15 },
      source: "cross-provider",
    })
  })

  test("exact rows win over case-variant rows when the exact candidates price", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      p1: provider("p1", { foo: model({ id: "foo", cost: { input: 2, output: 6 } }) }),
      p2: provider("p2", { Foo: model({ id: "Foo", cost: { input: 9, output: 27 } }) }),
    }
    // The real registry has 147 case-collision groups; merging case variants
    // into a priced exact set would change results, so exact candidates win.
    expect(Pricing.match(spread, { providerID: "other", modelID: "foo" })).toEqual({
      cost: { input: 2, output: 6 },
      source: "cross-provider",
    })
  })

  test("own-row lookup falls back to a unique case-insensitive model key", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      p1: provider("p1", { Foo: model({ id: "Foo", cost: { input: 5, output: 15 } }) }),
    }
    expect(Pricing.match(spread, { providerID: "p1", modelID: "foo" })).toEqual({
      cost: { input: 5, output: 15 },
      source: "declared",
    })
  })

  test("own-row lookup does not guess between multiple case-insensitive keys", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      p1: provider("p1", {
        Foo: model({ id: "Foo", cost: { input: 5, output: 15 } }),
        FOO: model({ id: "FOO", cost: { input: 7, output: 21 } }),
      }),
    }
    // Two case-insensitive hits: the own-row fallback declines (never
    // "declared") and any answer may only come from the cross-provider pass.
    expect(Pricing.match(spread, { providerID: "p1", modelID: "foo" })?.source).toBe("cross-provider")
  })

  test("cross-provider winner returns the canonical terminal row cost (lab list price)", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      lab: provider("lab", {
        "lab-model": model({ id: "lab-model", cost: { input: 50, output: 150 }, canonical: "lab/lab-model" }),
      }),
      a: provider("a", {
        "lab-model": model({ id: "lab-model", cost: { input: 5, output: 15 }, canonical: "lab/lab-model" }),
      }),
      b: provider("b", {
        "lab-model": model({ id: "lab-model", cost: { input: 5, output: 15 }, canonical: "lab/lab-model" }),
      }),
      c: provider("c", {
        "lab-model": model({ id: "lab-model", cost: { input: 5, output: 15 }, canonical: "lab/lab-model" }),
      }),
    }
    // Three voters @5 whose canonical target is @50: the winner's terminal row
    // is the lab's own list price — intended, the canonical target is the
    // authoritative price for the family, not the median of reseller rows.
    expect(Pricing.match(spread, { providerID: "other", modelID: "lab-model" })).toEqual({
      cost: { input: 50, output: 150 },
      source: "cross-provider",
    })
  })

  test("canonical chains stop cleanly when the target id is missing", () => {
    const spread: Record<string, ModelsDev.Provider> = {
      a: provider("a", { m: model({ id: "m", cost: zeroCost, canonical: "ghost/m" }) }),
      b: provider("b", { m: model({ id: "m", cost: zeroCost, canonical: "a/m" }) }),
    }
    // ~1248 real registry rows point at missing canonical targets; the walk
    // must stop without inventing a price or erroring.
    expect(Pricing.match(spread, { providerID: "b", modelID: "m" })).toBeUndefined()
    expect(Pricing.match(spread, { providerID: "a", modelID: "m" })).toBeUndefined()
  })

  test("ModelsDev.Model schema keeps canonical_model_id", () => {
    const decoded = Schema.decodeUnknownSync(ModelsDev.Model)({ ...model({ id: "m" }), canonical_model_id: "lab/m" })
    expect(decoded.canonical_model_id).toBe("lab/m")
  })
})

describe("Pricing.costOf", () => {
  test("base rates match a hand-expanded expected value", () => {
    const cost = Pricing.costOf(
      { input: 2, output: 6, cache: { read: 0.25, write: 2.5 } },
      { input: 1000, output: 500, reasoning: 200, cache: { read: 3000, write: 400 } },
      4400,
    )
    // (1000*2 + 500*6 + 3000*0.25 + 400*2.5 + 200*6) / 1e6 = 7950 / 1e6
    expect(cost).toBeCloseTo(0.00795, 10)
  })

  test("context tiers select the largest tier below the context size", () => {
    const rates: Pricing.Rates = {
      input: 3,
      output: 9,
      cache: { read: 0.3, write: 3 },
      tiers: [
        { input: 1, output: 2, cache: { read: 0.1, write: 0.2 }, tier: { type: "context", size: 200_000 } },
        { input: 1.5, output: 2.5, cache: { read: 0.15, write: 0.25 }, tier: { type: "context", size: 100_000 } },
      ],
    }
    const tokens = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(Pricing.costOf(rates, tokens, 50_000)).toBeCloseTo(3000 / 1_000_000, 12)
    expect(Pricing.costOf(rates, tokens, 150_000)).toBeCloseTo(1500 / 1_000_000, 12)
    expect(Pricing.costOf(rates, tokens, 250_000)).toBeCloseTo(1000 / 1_000_000, 12)
  })

  test("experimentalOver200K applies only above 200k context and only when no tier matches", () => {
    const over: Pricing.Rates = {
      input: 3,
      output: 9,
      cache: { read: 0.3, write: 3 },
      experimentalOver200K: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
    }
    const tokens = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(Pricing.costOf(over, tokens, 100_000)).toBeCloseTo(3000 / 1_000_000, 12)
    expect(Pricing.costOf(over, tokens, 250_000)).toBeCloseTo(1000 / 1_000_000, 12)

    const mixed: Pricing.Rates = {
      ...over,
      tiers: [{ input: 0.5, output: 1, cache: { read: 0.05, write: 0.1 }, tier: { type: "context", size: 300_000 } }],
    }
    expect(Pricing.costOf(mixed, tokens, 250_000)).toBeCloseTo(1000 / 1_000_000, 12)
    expect(Pricing.costOf(mixed, tokens, 350_000)).toBeCloseTo(500 / 1_000_000, 12)
  })

  test("reasoning tokens are billed at the output rate", () => {
    const cost = Pricing.costOf(
      { input: 0, output: 6, cache: { read: 0, write: 0 } },
      { input: 0, output: 0, reasoning: 100, cache: { read: 0, write: 0 } },
      0,
    )
    expect(cost).toBeCloseTo(600 / 1_000_000, 12)
  })
})

describe("Pricing.isZeroRates", () => {
  test("all-zero rates are unpriced", () => {
    expect(Pricing.isZeroRates({ input: 0, output: 0, cache: {} })).toBe(true)
    expect(Pricing.isZeroRates({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe(true)
    expect(Pricing.isZeroRates(Pricing.rates(undefined))).toBe(true)
    expect(Pricing.isZeroRates(Pricing.rates({ input: 0, output: 0, cache_read: 0, cache_write: 0 }))).toBe(true)
  })

  test("any nonzero rate anywhere is priced", () => {
    expect(Pricing.isZeroRates({ input: 1, output: 0, cache: {} })).toBe(false)
    expect(Pricing.isZeroRates({ input: 0, output: 0, cache: { read: 1 } })).toBe(false)
    expect(
      Pricing.isZeroRates({
        input: 0,
        output: 0,
        cache: {},
        tiers: [{ input: 0, output: 2, cache: {}, tier: { type: "context", size: 128_000 } }],
      }),
    ).toBe(false)
    expect(
      Pricing.isZeroRates({
        input: 0,
        output: 0,
        cache: {},
        experimentalOver200K: { input: 0, output: 0, cache: { write: 3 } },
      }),
    ).toBe(false)
    expect(Pricing.isZeroRates(Pricing.rates({ input: 0, output: 0, context_over_200k: { input: 1, output: 0 } }))).toBe(false)
  })
})

describe("Pricing conversions", () => {
  test("folds context_over_200k into an appended 200k context tier", () => {
    // Consistent with the plugin's registry→rates projection: the folded tier
    // competes by size with other tiers instead of sitting in a separate
    // experimentalOver200K branch any sub-200k tier could shadow.
    expect(
      Pricing.rates({
        input: 1,
        output: 2,
        cache_read: 0.5,
        cache_write: 0.25,
        context_over_200k: { input: 0.4, output: 0.8, cache_read: 0.04, cache_write: 0.08 },
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cache: { read: 0.5, write: 0.25 },
      tiers: [{ input: 0.4, output: 0.8, cache: { read: 0.04, write: 0.08 }, tier: { type: "context", size: 200_000 } }],
    })
  })

  test("appends the folded over-200k tier after existing tiers", () => {
    const rates = Pricing.rates({
      input: 1,
      output: 2,
      tiers: [{ input: 0.5, output: 1, cache_read: 0.05, cache_write: 0.1, tier: { type: "context", size: 128_000 } }],
      context_over_200k: { input: 0.4, output: 0.8 },
    })
    expect(rates.tiers).toEqual([
      { input: 0.5, output: 1, cache: { read: 0.05, write: 0.1 }, tier: { type: "context", size: 128_000 } },
      { input: 0.4, output: 0.8, cache: {}, tier: { type: "context", size: 200_000 } },
    ])
  })

  test("keeps absent cache fields absent through rates and registryCost", () => {
    const sparse = { input: 1, output: 2, cache_read: 0.5 }
    expect(Pricing.rates(sparse)).toEqual({ input: 1, output: 2, cache: { read: 0.5 } })
    expect(Pricing.registryCost(Pricing.rates(sparse))).toEqual(sparse)
    const bare = { input: 1, output: 2 }
    expect(Pricing.registryCost(Pricing.rates(bare))).toEqual(bare)
    const zeros = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    expect(Pricing.registryCost(Pricing.rates(zeros))).toEqual(zeros)
    expect(Pricing.rates(undefined)).toEqual({ input: 0, output: 0, cache: {} })
  })
})
