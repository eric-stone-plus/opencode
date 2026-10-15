export * as ForkPricingPlugin from "./pricing.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ForkPricing } from "../../fork/pricing.js"

/**
 * Prices models that exist only because a config provider declared them. The
 * catalog rows themselves are estimated in models.dev's normalize() (canonical
 * chain and cross-provider votes); a token-plan block that names `qwen3.8-max`
 * creates a model no catalog row backs, so it arrives here with a zero cost and
 * picks up the prevailing catalog price for its name. Runs in the post group,
 * after the config provider transform created those models.
 */
export const Plugin = define({
  id: "fork.pricing",
  effect: Effect.fn("ForkPricingPlugin")(function* (ctx) {
    yield* ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (ForkPricing.pricedModel(model.cost)) continue
        const estimate = ForkPricing.namedCost(model.modelID)
        if (estimate !== undefined) model.cost = [...estimate]
      }
    })
  }),
})
