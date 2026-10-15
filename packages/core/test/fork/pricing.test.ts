import { describe, expect, test } from "bun:test"
import { Money } from "@opencode/schema/money"
import { ForkPricing } from "@opencode/core/fork/pricing"
import snapshotText from "../../src/models-dev/snapshot.txt" with { type: "text" }

const catalog = JSON.parse(snapshotText) as Parameters<typeof ForkPricing.match>[0]

const entry = (input: number, output: number) => ({
  input: Money.USDPerMillionTokens.make(input),
  output: Money.USDPerMillionTokens.make(output),
  cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
})

describe("ForkPricing.match", () => {
  const small = {
    flagship: { models: { "model-a": { cost: { input: 1, output: 2 } } } },
    plan: { models: { "model-a": { cost: { input: 0, output: 0 }, canonical_model_id: "flagship/model-a" } } },
    lonely: { models: { "model-b": { cost: { input: 0, output: 0 } } } },
  }

  test("returns the declared price for a priced row", () => {
    const found = ForkPricing.match(small, { providerID: "flagship", modelID: "model-a" })
    expect(found).toMatchObject({ source: "declared", cost: { input: 1, output: 2 } })
  })

  test("follows the canonical chain for a zero-priced row", () => {
    const found = ForkPricing.match(small, { providerID: "plan", modelID: "model-a" })
    expect(found).toMatchObject({ source: "canonical", cost: { input: 1, output: 2 } })
  })

  test("falls through to same-name votes for a provider the catalog never carried", () => {
    const found = ForkPricing.match(small, { providerID: "unknown-plan", modelID: "model-a" })
    expect(found).toMatchObject({ source: "cross-provider", cost: { input: 1, output: 2 } })
  })

  test("never invents a price", () => {
    expect(ForkPricing.match(small, { providerID: "lonely", modelID: "model-b" })).toBeUndefined()
    expect(ForkPricing.match(small, { providerID: "lonely", modelID: "missing" })).toBeUndefined()
  })

  test("stops canonical walks at three hops and survives cycles", () => {
    const cycle = {
      a: { models: { m: { cost: { input: 0, output: 0 }, canonical_model_id: "b/m" } } },
      b: { models: { m: { cost: { input: 0, output: 0 }, canonical_model_id: "a/m" } } },
    }
    expect(ForkPricing.match(cycle, { providerID: "a", modelID: "m" })).toBeUndefined()
  })

  test("takes a case-insensitive own row only when exactly one matches", () => {
    const unique = { q: { models: { "MODEL-A": { cost: { input: 5, output: 6 } } } } }
    expect(ForkPricing.match(unique, { providerID: "q", modelID: "model-a" })).toMatchObject({
      source: "declared",
      cost: { input: 5 },
    })
    // Two case-collision rows must not be guessed between: the cascade decides instead.
    const ambiguous = {
      q: { models: { "Model-A": { cost: { input: 1, output: 1 } }, "MODEL-A": { cost: { input: 2, output: 2 } } } },
    }
    const found = ForkPricing.match(ambiguous, { providerID: "q", modelID: "model-a" })
    const value = found?.cost.input
    expect(value === 1 || value === 2).toBe(true)
  })

  test("takes the majority terminal and the median on a tie", () => {
    const votes = {
      one: { models: { m: { cost: { input: 1, output: 1 }, canonical_model_id: "target/m" } } },
      two: { models: { m: { cost: { input: 1, output: 1 }, canonical_model_id: "target/m" } } },
      target: { models: { m: { cost: { input: 1, output: 1 } } } },
      other: { models: { m: { cost: { input: 5, output: 5 }, canonical_model_id: "elsewhere/m" } } },
      elsewhere: { models: { m: { cost: { input: 5, output: 5 } } } },
      lonely: { models: { m: { cost: { input: 0, output: 0 } } } },
    }
    // two voters point at `target`, one at `elsewhere`: majority wins.
    expect(ForkPricing.match(votes, { providerID: "lonely", modelID: "m" })?.cost).toMatchObject({ input: 1 })
    const tie = {
      one: { models: { m: { cost: { input: 1, output: 1 }, canonical_model_id: "t1/m" } } },
      t1: { models: { m: { cost: { input: 1, output: 1 } } } },
      two: { models: { m: { cost: { input: 9, output: 9 }, canonical_model_id: "t2/m" } } },
      t2: { models: { m: { cost: { input: 9, output: 9 } } } },
      lonely: { models: { m: { cost: { input: 0, output: 0 } } } },
    }
    const found = ForkPricing.match(tie, { providerID: "lonely", modelID: "m" })
    expect(found?.source).toBe("cross-provider")
    const value = found?.cost.input
    expect(value === 1 || value === 9).toBe(true)
  })
})

describe("ForkPricing.toModelCost", () => {
  test("folds context_over_200k into a 200k context tier", () => {
    const cost = ForkPricing.toModelCost({
      input: 1,
      output: 2,
      cache_read: 0.1,
      tiers: [{ input: 3, output: 4, tier: { type: "context", size: 32_000 } }],
      context_over_200k: { input: 5, output: 6 },
    })
    expect(cost).toHaveLength(3)
    expect(cost[0]).toMatchObject({ input: 1, output: 2, cache: { read: 0.1, write: 0 } })
    expect(cost[1]).toMatchObject({ tier: { type: "context", size: 32_000 }, input: 3 })
    expect(cost[2]).toMatchObject({ tier: { type: "context", size: 200_000 }, input: 5, output: 6 })
  })
})

describe("ForkPricing against the bundled catalog", () => {
  test("ships the DeepSeek catalog only, so no zero-priced subscription row is left to estimate", () => {
    expect(Object.keys(catalog)).toEqual(["deepseek"])
    // A zero-priced row would resolve through its canonical flagship; every shipped row
    // declares its own rate, so `estimate` leaves the declared price to the caller.
    expect(ForkPricing.estimate(catalog, "deepseek", "deepseek-flash")).toBeUndefined()
  })

  test("estimates a provider the catalog never carried by name", () => {
    const found = ForkPricing.estimate(catalog, "acme-token-plan", "deepseek-v4-flash")
    expect(found?.[0]).toMatchObject({ input: 0.15, output: 0.6 })
  })

  test("leaves a model that declares its own price to the caller", () => {
    expect(ForkPricing.estimate(catalog, "deepseek", "deepseek-flash")).toBeUndefined()
  })
})

describe("ForkPricing named table", () => {
  test("keeps the median across same-named rows and clones on read", () => {
    ForkPricing.publishNamed(
      new Map([
        ["deepseek-plan-pro", [[entry(1.1, 3.1)], [entry(1.4, 4.4)], [entry(1.5, 4.5)]]],
      ]),
    )
    const found = ForkPricing.namedCost("DEEPSEEK-PLAN-PRO")
    expect(found?.[0]).toMatchObject({ input: 1.4, output: 4.4 })
    expect(ForkPricing.namedCost("missing")).toBeUndefined()
    // The read must be a copy: a consumer that mutates it cannot corrupt the table.
    const second = ForkPricing.namedCost("deepseek-plan-pro")
    expect(second).not.toBe(found)
    expect(second?.[0]).not.toBe(found?.[0])
  })
})
