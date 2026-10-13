import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { ForkPricing } from "@opencode/core/fork/pricing"
import { ForkPricingPlugin } from "@opencode/core/plugin/fork/pricing"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../../fixture/location"
import { testEffect } from "../../lib/effect"
import { host, modelHost } from "../host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Provider.node, Model.node, Bus.node]), [
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make("/workspace") })),
      ),
    ),
  ]),
)

const entry = (input: number, output: number) => ({
  input: Money.USDPerMillionTokens.make(input),
  output: Money.USDPerMillionTokens.make(output),
  cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
})

/** Declares a token-plan provider and a model with no catalog row, the way a config block creates one. */
const declare = (providerID: string, modelID: string) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    yield* providers.transform((editor) => {
      editor.update(Provider.ID.make(providerID), (provider) => {
        provider.activation = "enabled"
      })
      editor.models.update(Provider.ID.make(providerID), Model.ID.make(modelID), (model) => {
        model.name = modelID
      })
    })
  })

describe("fork pricing plugin", () => {
  it.effect("prices a config-created model from the catalog name table", () =>
    Effect.gen(function* () {
      ForkPricing.publishNamed(new Map([["mimo-v2.6-pro", [[entry(1.4, 4.4)]]], ["flag", [[entry(7, 8)]]]]))
      yield* declare("mimo-coding-plan", "mimo-v2.6-pro")
      yield* declare("mimo-coding-plan", "flag")
      // `flag` is priced by a catalog row of its own name, `mimo-v2.6-pro` never had a row here.
      yield* declare("mimo-coding-plan", "untouched")
      const models = yield* Model.Service
      yield* models.transform((editor) =>
        editor.update(Provider.ID.make("mimo-coding-plan"), Model.ID.make("untouched"), (model) => {
          model.cost = [entry(9, 9)]
        }),
      )
      yield* ForkPricingPlugin.Plugin.effect(host({ model: modelHost(yield* Model.Service) })).pipe(Effect.orDie)
      const priced = yield* models.get(Provider.ID.make("mimo-coding-plan"), Model.ID.make("mimo-v2.6-pro"))
      expect(priced?.cost[0]).toMatchObject({ input: 1.4, output: 4.4 })
      const kept = yield* models.get(Provider.ID.make("mimo-coding-plan"), Model.ID.make("untouched"))
      expect(kept?.cost[0]).toMatchObject({ input: 9, output: 9 })
    }),
  )

  it.effect("leaves a model with no matching name alone", () =>
    Effect.gen(function* () {
      ForkPricing.publishNamed(new Map())
      yield* declare("mimo-coding-plan", "unknown-model")
      yield* ForkPricingPlugin.Plugin.effect(host({ model: modelHost(yield* Model.Service) })).pipe(Effect.orDie)
      const models = yield* Model.Service
      const found = yield* models.get(Provider.ID.make("mimo-coding-plan"), Model.ID.make("unknown-model"))
      expect(ForkPricing.pricedModel(found?.cost ?? [])).toBe(false)
    }),
  )
})
