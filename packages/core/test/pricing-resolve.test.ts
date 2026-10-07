import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Pricing } from "@opencode-ai/core/pricing"
import { it } from "./lib/effect"

// test/preload.ts disables models fetches for every test file; these tests
// exercise the fetch throttle itself, so allow fetches and restore afterwards
// (same save/restore pattern as models.test.ts).
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = false
})
afterAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

// ModelsDev.Service mock pattern (see models.test.ts / plugin/models-dev.test.ts):
// a stub registry with a controllable refresh outcome and call counter.
type Mock = {
  registry: Record<string, ModelsDev.Provider>
  refreshes: number
  refreshed: boolean
}

const mock = (state: Mock) =>
  Layer.succeed(
    ModelsDev.Service,
    ModelsDev.Service.of({
      get: () => Effect.succeed(state.registry),
      refresh: () =>
        Effect.sync(() => {
          state.refreshes++
          return state.refreshed
        }),
    }),
  )

const pricingLayer = (state: Mock) =>
  // Layer.fresh: Pricing.layer is a module-level constant and Effect.provide
  // memoizes layers process-globally — without fresh the memo/throttle state
  // would leak across tests.
  Layer.fresh(AppNodeBuilder.build(LayerNode.group([Pricing.node, EventV2.node]), [[ModelsDev.node, mock(state)]]))

const gone = {
  id: "gone",
  name: "Gone",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
}

const pricedRow = (input: number) => ({
  id: "priced",
  name: "Priced",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  cost: { input, output: input * 3 },
})

const unpriced = (): Record<string, ModelsDev.Provider> => ({
  p: { id: "p", name: "p", env: [], models: { gone } },
})

const registryWithPriced = (input: number): Record<string, ModelsDev.Provider> => ({
  p: { id: "p", name: "p", env: [], models: { gone, priced: pricedRow(input) } },
})

const mockState = (registry: Record<string, ModelsDev.Provider>, refreshed = true): Mock => ({
  registry,
  refreshes: 0,
  refreshed,
})

describe("Pricing.Service.resolve", () => {
  it.effect("positive offline matches never trigger a fetch", () => {
    const state = mockState(registryWithPriced(2))
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toEqual({
        cost: { input: 2, output: 6 },
        source: "declared",
      })
      expect(state.refreshes).toBe(0)
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.effect("an unpriced miss attempts one refresh and memoizes the negative", () => {
    const state = mockState(unpriced())
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(1)
      // Negative memo short-circuits: no re-match, no extra fetch.
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(1)
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.effect("negative memo entries expire after five minutes", () => {
    const state = mockState(unpriced())
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toBeUndefined()
      // The on-disk registry gains a row without a Refreshed event (e.g. a
      // sibling process refreshed the cache): only negative-memo expiry can
      // notice it.
      state.registry = registryWithPriced(3)
      yield* TestClock.adjust(Duration.minutes(1))
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toBeUndefined()
      yield* TestClock.adjust(Duration.minutes(5))
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toEqual({
        cost: { input: 3, output: 9 },
        source: "declared",
      })
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.effect("a failed refresh retries after the 5-minute backoff instead of burning 24h", () => {
    const state = mockState(unpriced(), false)
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(1)
      yield* TestClock.adjust(Duration.minutes(6))
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(2)
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.effect("a successful refresh suppresses further fetches for 24h", () => {
    const state = mockState(unpriced())
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(1)
      yield* TestClock.adjust(Duration.minutes(6))
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(1)
      yield* TestClock.adjust(Duration.hours(25))
      expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
      expect(state.refreshes).toBe(2)
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.effect("OPENCODE_DISABLE_MODELS_FETCH suppresses fetches entirely", () => {
    const state = mockState(unpriced())
    return Effect.gen(function* () {
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Flag.OPENCODE_DISABLE_MODELS_FETCH = true
        }),
        () =>
          Effect.gen(function* () {
            const pricing = yield* Pricing.Service
            expect(yield* pricing.resolve({ providerID: "p", modelID: "gone" })).toBeUndefined()
            expect(state.refreshes).toBe(0)
          }),
        () =>
          Effect.sync(() => {
            Flag.OPENCODE_DISABLE_MODELS_FETCH = false
          }),
      )
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.live("memoized hits are cleared when ModelsDev.Event.Refreshed fires", () => {
    const state = mockState(registryWithPriced(2))
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      const events = yield* EventV2.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toEqual({
        cost: { input: 2, output: 6 },
        source: "declared",
      })
      state.registry = registryWithPriced(5)
      yield* events.publish(ModelsDev.Event.Refreshed, {})
      // The clear runs on a subscription fiber; give it a beat (same settle
      // pattern as models.test.ts).
      yield* Effect.sleep("50 millis")
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toEqual({
        cost: { input: 5, output: 15 },
        source: "declared",
      })
    }).pipe(Effect.provide(pricingLayer(state)))
  })

  it.live("negative memo entries are cleared when ModelsDev.Event.Refreshed fires", () => {
    const state = mockState(unpriced())
    return Effect.gen(function* () {
      const pricing = yield* Pricing.Service
      const events = yield* EventV2.Service
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toBeUndefined()
      state.registry = registryWithPriced(9)
      yield* events.publish(ModelsDev.Event.Refreshed, {})
      yield* Effect.sleep("50 millis")
      expect(yield* pricing.resolve({ providerID: "p", modelID: "priced" })).toEqual({
        cost: { input: 9, output: 27 },
        source: "declared",
      })
    }).pipe(Effect.provide(pricingLayer(state)))
  })
})
