import path from "path"
import { describe, expect } from "bun:test"
import { Money } from "@opencode/schema/money"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Integration } from "@opencode/core/integration"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelsDev } from "@opencode/core/models-dev"
import { ModelsDevPlugin } from "@opencode/core/plugin/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { withEnv } from "../fixture/env"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { providerHost, host, integrationHost } from "./host"
import { PluginTestLayer } from "./fixture"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Provider.node, Model.node, Integration.node, Bus.node]), [
  Location.node.replace(locationLayer),
])
const it = testEffect(layer)
const real = testEffect(PluginTestLayer)
const isolated = testEffect(Layer.empty)
const models = (file: string) =>
  AppNodeBuilder.build(ModelsDev.node, [ModelsDev.node.replace(ModelsDev.configured({ file, fetch: false }))])

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function activate(providers: Provider.Interface) {
  return providers.transform((editor) => {
    for (const record of editor.list())
      editor.update(record.provider.id, (provider) => {
        provider.activation = "enabled"
      })
  })
}

// One complete Location graph behind the production plugin host. Two of these stand in for
// two Locations that share a single models.dev snapshot instance.
const owner = Effect.gen(function* () {
  const context = yield* Layer.build(PluginTestLayer)
  const host = yield* PluginHost.make(Context.get(context, Plugin.Service)).pipe(Effect.provideContext(context))
  return {
    context,
    host,
    bus: Context.get(context, Bus.Service),
    providers: Context.get(context, Provider.Service),
    models: Context.get(context, Model.Service),
    integration: Context.get(context, Integration.Service),
  }
})

// Every nested overlay shape the normalized snapshot can carry, so in-place mutation of any
// existing nested value is observable on the source object.
const richSnapshot = (name = "Acme") => {
  const providerID = Provider.ID.make("acme")
  const modelID = Model.ID.make("gpt-5.4")
  const snapshot = [
    {
      info: {
        id: providerID,
        name,
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.acme.test/v1", thinking: { type: "adaptive", display: "summarized" } },
        headers: { "x-acme": "provider" },
        body: { service_tier: "default", tags: ["stable"] },
      },
      environment: ["ACME_API_KEY", "ACME_HOST"],
      models: [
        {
          id: modelID,
          modelID,
          providerID,
          name: "GPT-5.4",
          family: Model.Family.make("gpt"),
          settings: { baseURL: "https://models.acme.test/v1", reasoning: { effort: "low" } },
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority", options: { top_k: 1 }, stop: ["<end>"] },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [
            {
              id: Model.VariantID.make("low"),
              settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
              body: { max_tokens: 1024 },
            },
          ],
          time: { released: Date.parse("2026-01-01") },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(2.5),
              output: Money.USDPerMillionTokens.make(15),
              cache: { read: Money.USDPerMillionTokens.make(0.25), write: Money.USDPerMillionTokens.zero },
            },
            {
              tier: { type: "context", size: 200_000 },
              input: Money.USDPerMillionTokens.make(5),
              output: Money.USDPerMillionTokens.make(22.5),
              cache: { read: Money.USDPerMillionTokens.make(0.5), write: Money.USDPerMillionTokens.zero },
            },
          ],
          status: "active",
          enabled: true,
          limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        },
      ],
    },
  ] satisfies readonly ModelsDev.Snapshot[]
  return { providerID, modelID, snapshot }
}

describe("ModelsDevPlugin", () => {
  isolated.effect("shares definitions between Locations while provider and model edits own their copies", () =>
    Effect.gen(function* () {
      const { providerID, modelID, snapshot } = richSnapshot()
      const pristine = JSON.stringify(snapshot)
      const source = ModelsDev.Service.of({ get: () => Effect.succeed(snapshot), refresh: () => Effect.void })
      const first = yield* owner
      const second = yield* owner
      for (const each of [first, second]) {
        yield* ModelsDevPlugin.effect(each.host).pipe(
          Effect.provideService(ModelsDev.Service, source),
          Effect.provideContext(each.context),
        )
        yield* activate(each.providers)
      }

      const definitions = required((yield* first.providers.snapshot()).records.get(providerID)).models
      expect(definitions.get(modelID)).toBe(snapshot[0].models[0])
      expect(required((yield* second.providers.snapshot()).records.get(providerID)).models).toBe(definitions)

      // The stored environment method must own its names array; the source array is shared.
      let names: readonly string[] | undefined
      yield* first.integration.transform((draft) => {
        names = draft.method
          .list(Integration.ID.make(providerID))
          .flatMap((method) => (method.type === "env" ? [method.names] : []))[0]
      })
      expect(names).toEqual(snapshot[0].environment)
      expect(names).not.toBe(snapshot[0].environment)

      // Provider-owned records are copies, not the source's nested objects.
      const stored = required(yield* first.providers.get(providerID))
      expect(stored.settings).toEqual(snapshot[0].info.settings)
      expect(stored.settings).not.toBe(snapshot[0].info.settings)
      expect(stored.headers).not.toBe(snapshot[0].info.headers)
      expect(stored.body).not.toBe(snapshot[0].info.body)

      // A later plugin in the first Location mutates existing nested values in place through the
      // production host, the way the Bedrock, Azure, and config provider plugins do.
      const scope = yield* Scope.make()
      yield* first.host.provider
        .transform((editor) => {
          editor.update(providerID, (provider) => {
            required(provider.settings).baseURL = "https://override.acme.test/v1"
            required(provider.settings).thinking.type = "disabled"
            required(provider.headers)["x-acme"] = "override"
            required(provider.body).service_tier = "priority"
            required(provider.body).tags.push("override")
          })
        })
        .pipe(Scope.provide(scope))
      yield* first.host.model
        .transform((editor) => {
          editor.update(providerID, modelID, (model) => {
            required(model.settings).reasoning.effort = "high"
            required(model.headers)["x-mode"] = "slow"
            required(model.body).options.top_k = 7
            required(model.body).stop.push("<stop>")
            const variant = required(model.variants[0])
            required(variant.settings).thinking.type = "disabled"
            required(variant.body).max_tokens = 4096
            model.capabilities.input.push("image")
            required(model.cost[0]).cache.read = Money.USDPerMillionTokens.make(9)
            required(required(model.cost[1]).tier).size = 1
            required(model.cost[1]).input = Money.USDPerMillionTokens.make(42)
            model.limit.context = 1
            model.time.released = 5
          })
        })
        .pipe(Scope.provide(scope))

      const mutatedProvider = required(yield* first.providers.get(providerID))
      const mutated = required(yield* first.models.get(providerID, modelID))
      expect(mutatedProvider.settings).toEqual({
        baseURL: "https://override.acme.test/v1",
        thinking: { type: "disabled", display: "summarized" },
      })
      expect(mutatedProvider.headers).toEqual({ "x-acme": "override" })
      expect(mutatedProvider.body).toEqual({ service_tier: "priority", tags: ["stable", "override"] })
      expect(mutated.settings).toEqual({
        baseURL: "https://models.acme.test/v1",
        thinking: { type: "disabled", display: "summarized" },
        reasoning: { effort: "high" },
      })
      expect(mutated.headers).toEqual({ "x-acme": "override", "x-mode": "slow" })
      expect(mutated.body).toEqual({
        service_tier: "priority",
        tags: ["stable", "override"],
        options: { top_k: 7 },
        stop: ["<end>", "<stop>"],
      })
      expect(mutated.variants).toEqual([
        {
          id: Model.VariantID.make("low"),
          settings: { thinking: { type: "disabled", display: "summarized" }, effort: "low" },
          body: { max_tokens: 4096 },
        },
      ])
      expect(mutated.capabilities.input).toEqual(["text", "image"])
      expect(mutated.cost[0]?.cache.read).toBe(Money.USDPerMillionTokens.make(9))
      expect(mutated.cost[1]).toMatchObject({ tier: { type: "context", size: 1 }, input: 42 })
      expect(mutated.limit.context).toBe(1)
      expect(mutated.time.released).toBe(5)

      // The sibling Location and the shared source are untouched.
      const sibling = required(yield* second.models.get(providerID, modelID))
      expect(sibling.settings).toEqual({
        baseURL: "https://models.acme.test/v1",
        thinking: { type: "adaptive", display: "summarized" },
        reasoning: { effort: "low" },
      })
      expect(sibling.headers).toEqual({ "x-acme": "provider", "x-mode": "fast" })
      expect(sibling.body).toEqual({
        service_tier: "priority",
        tags: ["stable"],
        options: { top_k: 1 },
        stop: ["<end>"],
      })
      expect(sibling.variants).toEqual(snapshot[0].models[0].variants)
      expect(sibling.capabilities.input).toEqual(["text"])
      expect(sibling.cost).toEqual(snapshot[0].models[0].cost)
      expect(sibling.limit).toEqual(snapshot[0].models[0].limit)
      expect(sibling.time).toEqual(snapshot[0].models[0].time)
      expect(required(yield* second.providers.get(providerID)).settings).toEqual(snapshot[0].info.settings)
      expect(JSON.stringify(snapshot)).toBe(pristine)

      // Removing both mutating transforms replays the shared definitions.
      yield* Scope.close(scope, Exit.void)
      expect(yield* first.models.get(providerID, modelID)).toEqual(sibling)
      expect(required(yield* first.providers.get(providerID)).settings).toEqual(snapshot[0].info.settings)
      expect(JSON.stringify(snapshot)).toBe(pristine)
    }),
  )

  isolated.effect("replaces its snapshot reference on refresh without touching the sibling Location", () =>
    Effect.gen(function* () {
      const initial = richSnapshot("Acme")
      const refreshed = richSnapshot("Acme Refreshed")
      const pristine = JSON.stringify(initial.snapshot)
      const current = { snapshot: initial.snapshot }
      const source = ModelsDev.Service.of({
        get: () => Effect.sync(() => current.snapshot),
        refresh: () => Effect.void,
      })
      const first = yield* owner
      const second = yield* owner
      for (const each of [first, second])
        yield* ModelsDevPlugin.effect(each.host).pipe(
          Effect.provideService(ModelsDev.Service, source),
          Effect.provideContext(each.context),
        )
      expect(required(yield* first.providers.get(initial.providerID)).name).toBe("Acme")

      current.snapshot = refreshed.snapshot
      yield* first.bus.publish(ModelsDev.Event.Refreshed, {})
      // Integration and provider reloads are debounced sequentially.
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")

      expect(required(yield* first.providers.get(initial.providerID)).name).toBe("Acme Refreshed")
      expect(required(yield* second.providers.get(initial.providerID)).name).toBe("Acme")
      expect(JSON.stringify(initial.snapshot)).toBe(pristine)
      expect(JSON.stringify(refreshed.snapshot)).toBe(JSON.stringify(richSnapshot("Acme Refreshed").snapshot))
    }),
  )

  isolated.effect("adopts a refresh that completes between its initial read and its subscription", () =>
    Effect.gen(function* () {
      const bundled = richSnapshot("Acme Bundled")
      const fresh = richSnapshot("Acme Fresh")
      const current = { snapshot: bundled.snapshot }
      const location = yield* owner
      // Cold cache: the first read serves the bundled snapshot, and the boot-time
      // ModelsDev.refresh() lands right after it, before the plugin subscribes.
      const source = ModelsDev.Service.of({
        get: () =>
          Effect.gen(function* () {
            const data = current.snapshot
            if (data !== bundled.snapshot) return data
            current.snapshot = fresh.snapshot
            yield* location.bus.publish(ModelsDev.Event.Refreshed, {})
            return data
          }),
        refresh: () => Effect.void,
      })
      yield* ModelsDevPlugin.effect(location.host).pipe(
        Effect.provideService(ModelsDev.Service, source),
        Effect.provideContext(location.context),
      )
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")

      expect(required(yield* location.providers.get(bundled.providerID)).name).toBe("Acme Fresh")
    }),
  )

  real.effect("keeps the retained definition unchanged across model replay", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const plugins = yield* Plugin.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("model")
      const modelsDev = ModelsDev.Service.of({
        get: () =>
          Effect.succeed([
            {
              info: {
                id: providerID,
                name: "Acme",
                activation: "auto",
                package: "@opencode/ai/providers/openai-compatible",
              },
              environment: [],
              models: [
                {
                  id: modelID,
                  modelID,
                  providerID,
                  name: "Model",
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [],
                  status: "active",
                  enabled: true,
                  limit: { context: 128_000, output: 32_000 },
                },
              ],
            },
          ] satisfies readonly ModelsDev.Snapshot[]),
        refresh: () => Effect.void,
      })
      const pluginHost = yield* PluginHost.make(plugins)
      yield* ModelsDevPlugin.effect(pluginHost).pipe(Effect.provideService(ModelsDev.Service, modelsDev))
      yield* activate(providers)

      const scope = yield* Scope.make()
      yield* modelState
        .transform((editor) =>
          editor.update(providerID, modelID, (model) => {
            model.variants ??= []
            model.variants.push({ id: Model.VariantID.make("configured") })
          }),
        )
        .pipe(Scope.provide(scope))
      expect((yield* modelState.get(providerID, modelID))?.variants).toEqual([
        { id: Model.VariantID.make("configured") },
      ])

      yield* Scope.close(scope, Exit.void)
      expect((yield* modelState.get(providerID, modelID))?.variants).toEqual([])
    }),
  )

  it.effect("keeps the shared snapshot pristine while provider and model transforms mutate owned records", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      const snapshot = [
        {
          info: {
            id: providerID,
            name: "Acme",
            activation: "auto",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: "https://api.acme.test/v1" },
            headers: { "x-acme": "provider" },
          },
          environment: ["ACME_API_KEY"],
          models: [
            {
              id: modelID,
              modelID,
              providerID,
              name: "GPT-5.4",
              settings: { baseURL: "https://models.acme.test/v1" },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: Date.parse("2026-01-01") },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 1_050_000, output: 128_000 },
            },
          ],
        },
      ] satisfies readonly ModelsDev.Snapshot[]
      const pristine = JSON.stringify(snapshot)
      // The plugin receives the same snapshot instance every Location shares.
      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({ get: () => Effect.succeed(snapshot), refresh: () => Effect.void }),
        ),
      )

      yield* activate(providers)
      // Each stage mutates its owned records without modifying shared source definitions.
      yield* providers.transform((draft) => {
        draft.update(providerID, (provider) => {
          if (provider.settings) provider.settings.baseURL = "https://override.acme.test/v1"
          if (provider.headers) provider.headers["x-acme"] = "override"
        })
      })
      yield* modelState.transform((draft) => {
        draft.update(providerID, modelID, (model) => {
          if (model.settings) model.settings.baseURL = "https://override.models.acme.test/v1"
          model.variants.push({ id: Model.VariantID.make("configured") })
          model.capabilities.input.push("image")
        })
      })

      const provider = yield* providers.get(providerID)
      const model = yield* modelState.get(providerID, modelID)
      expect(provider?.settings?.baseURL).toBe("https://override.acme.test/v1")
      expect(provider?.headers).toEqual({ "x-acme": "override" })
      expect(model?.settings?.baseURL).toBe("https://override.models.acme.test/v1")
      expect(model?.variants).toEqual([{ id: Model.VariantID.make("configured") }])
      expect(model?.capabilities.input).toEqual(["text", "image"])
      expect(JSON.stringify(snapshot)).toBe(pristine)
    }),
  )

  it.effect("projects normalized definitions for available providers", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed([
            {
              info: {
                id: providerID,
                name: "Acme",
                activation: "auto",
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: "https://api.acme.test/v1" },
              },
              environment: [],
              models: [
                {
                  id: modelID,
                  modelID,
                  providerID,
                  name: "GPT-5.4",
                  family: Model.Family.make("gpt"),
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(2.5),
                      output: Money.USDPerMillionTokens.make(15),
                      cache: {
                        read: Money.USDPerMillionTokens.zero,
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
                {
                  id: Model.ID.make("gpt-5.4-fast"),
                  modelID,
                  providerID,
                  name: "GPT-5.4 Fast",
                  family: Model.Family.make("gpt"),
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { baseURL: "https://api.acme.test/v1" },
                  headers: { "x-mode": "fast" },
                  body: { service_tier: "priority" },
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(30),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
              ],
            },
          ] satisfies readonly ModelsDev.Snapshot[]),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))
      yield* activate(providers)

      const base = yield* modelState.get(providerID, Model.ID.make("gpt-5.4"))
      const fast = yield* modelState.get(providerID, Model.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.body).toBeUndefined()
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        modelID: "gpt-5.4",
        providerID: "acme",
        name: "GPT-5.4 Fast",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.acme.test/v1" },
        headers: { "x-mode": "fast" },
        body: { service_tier: "priority" },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        {
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(30),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 272_000 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(18),
          cache: {
            read: Money.USDPerMillionTokens.make(0.25),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(22.5),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
      ])
    }),
  )

  it.effect("omits deprecated and non-text model definitions", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const providerID = Provider.ID.make("acme")
      const activeID = Model.ID.make("current")
      const deprecatedID = Model.ID.make("legacy")
      const videoID = Model.ID.make("video-gen")
      const sttID = Model.ID.make("transcribe")
      const model = {
        modelID: activeID,
        providerID,
        name: "Current",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: Date.parse("2026-01-01") },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 128_000, output: 32_000 },
      } satisfies Omit<Model.Info, "id">
      const snapshots = [
        {
          info: {
            id: providerID,
            name: "Acme",
            activation: "auto",
            package: "@opencode/ai/providers/openai-compatible",
          },
          environment: [],
          models: [
            { id: activeID, ...model },
            {
              id: deprecatedID,
              ...model,
              modelID: deprecatedID,
              name: "Legacy",
              status: "deprecated" as const,
            },
            {
              id: videoID,
              ...model,
              modelID: videoID,
              name: "Video Gen",
              capabilities: { tools: false, input: ["text", "image"], output: ["video"] },
              limit: { context: 1_024, output: 0 },
            },
            {
              id: sttID,
              ...model,
              modelID: sttID,
              name: "Transcribe",
              capabilities: { tools: false, input: ["audio"], output: ["text"] },
            },
          ],
        },
      ] satisfies readonly ModelsDev.Snapshot[]

      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({
            get: () => Effect.succeed(snapshots),
            refresh: () => Effect.void,
          }),
        ),
      )

      yield* activate(providers)
      expect(yield* modelState.get(providerID, activeID)).toBeDefined()
      expect(yield* modelState.get(providerID, deprecatedID)).toBeUndefined()
      expect(yield* modelState.get(providerID, videoID)).toBeUndefined()
      expect(yield* modelState.get(providerID, sttID)).toBeUndefined()
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      )
      expect(yield* integrations.list()).toEqual([
        Integration.Info.make({
          id: Integration.ID.make("deepseek"),
          name: "DeepSeek",
          methods: [
            { type: "key" },
            {
              type: "env",
              names: ["DEEPSEEK_API_KEY"],
            },
          ],
          connections: [],
        }),
      ])
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev.json")))),
  )

  it.effect("preserves provider and model URL templates in the catalog", () =>
    withEnv(
      {
        ACME_HOST: "api.acme.test",
        ACME_MODEL_PATH: undefined,
        UNDECLARED_HOST: "private.example",
      },
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const providers = yield* Provider.Service
          const modelState = yield* Model.Service
          const providerID = Provider.ID.make("acme")
          const modelID = Model.ID.make("gpt-5.4")
          yield* ModelsDevPlugin.effect(
            host({
              provider: providerHost(providers),
              integration: integrationHost(integrations),
            }),
          ).pipe(
            Effect.provideService(
              ModelsDev.Service,
              ModelsDev.Service.of({
                get: () =>
                  Effect.succeed([
                    {
                      info: {
                        id: providerID,
                        name: "Acme",
                        activation: "auto",
                        package: "@opencode/ai/providers/openai-compatible",
                        settings: { baseURL: "https://${ACME_HOST}/${UNDECLARED_HOST}/v1" },
                      },
                      environment: ["ACME_HOST", "ACME_MODEL_PATH", "ACME_API_KEY"],
                      models: [
                        {
                          id: modelID,
                          modelID,
                          providerID,
                          name: "GPT-5.4",
                          settings: { baseURL: "https://${ACME_HOST}/${ACME_MODEL_PATH}/v1" },
                          capabilities: { tools: true, input: [], output: [] },
                          variants: [],
                          time: { released: Date.parse("2026-01-01") },
                          cost: [],
                          status: "active",
                          enabled: true,
                          limit: { context: 1_050_000, output: 128_000 },
                        },
                      ],
                    },
                  ] satisfies readonly ModelsDev.Snapshot[]),
                refresh: () => Effect.void,
              }),
            ),
          )

          yield* activate(providers)
          expect((yield* providers.get(providerID))?.settings?.baseURL).toBe(
            "https://${ACME_HOST}/${UNDECLARED_HOST}/v1",
          )
          expect((yield* modelState.get(providerID, modelID))?.settings?.baseURL).toBe(
            "https://${ACME_HOST}/${ACME_MODEL_PATH}/v1",
          )
        }),
    ),
  )

  it.effect("copies model request bodies without reinterpreting literal __proto__ keys", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      // A JSON body may legitimately contain a "__proto__" key; both copy stages must keep it as an own property.
      const body = JSON.parse('{"__proto__":{"service_tier":"priority"},"keep":true}') as Record<string, unknown>
      const snapshot = {
        info: {
          id: providerID,
          name: "Acme",
          activation: "auto",
          package: "@opencode/ai/providers/openai-compatible",
        },
        environment: [],
        models: [
          {
            id: modelID,
            modelID,
            providerID,
            name: "GPT-5.4",
            capabilities: { tools: true, input: [], output: [] },
            variants: [],
            time: { released: Date.parse("2026-01-01") },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 1_050_000, output: 128_000 },
            body,
          },
        ],
      } satisfies ModelsDev.Snapshot
      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({ get: () => Effect.succeed([snapshot]), refresh: () => Effect.void }),
        ),
      )

      yield* activate(providers)
      const copied = (yield* modelState.get(providerID, modelID))?.body
      expect(copied).not.toBe(body)
      expect(Object.hasOwn(copied ?? {}, "__proto__")).toBe(true)
      expect(Object.keys(copied ?? {})).toEqual(["__proto__", "keep"])
      expect(JSON.stringify(copied)).toBe(JSON.stringify(body))
      expect(copied).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("converts reasoning options into settings variants", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const modelState = yield* Model.Service
      const integrations = yield* Integration.Service
      yield* ModelsDevPlugin.effect(
        host({
          provider: providerHost(providers),
          integration: integrationHost(integrations),
        }),
      )

      yield* activate(providers)
      const deepseek = Provider.ID.make("deepseek")
      const model = yield* modelState.get(deepseek, Model.ID.make("deepseek-reasoning"))
      expect(model?.variants).toEqual([
        { id: Model.VariantID.make("none"), body: { thinking: { type: "disabled" } } },
        {
          id: Model.VariantID.make("low"),
          settings: { reasoningEffort: "low" },
          body: { thinking: { type: "enabled" } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { reasoningEffort: "high" },
          body: { thinking: { type: "enabled" } },
        },
      ])

      const mode = yield* modelState.get(deepseek, Model.ID.make("deepseek-reasoning-high"))
      expect(mode).toMatchObject({
        id: "deepseek-reasoning-high",
        name: "DeepSeek Reasoning High",
        headers: { "x-mode": "high" },
        body: { service_tier: "priority" },
      })
      expect(mode?.variants?.map((variant) => variant.id)).toEqual([
        Model.VariantID.make("none"),
        Model.VariantID.make("low"),
        Model.VariantID.make("high"),
      ])

      const pro = yield* modelState.get(deepseek, Model.ID.make("deepseek-reasoning-pro"))
      expect(pro).toMatchObject({
        id: "deepseek-reasoning-pro",
        body: { reasoning: { mode: "pro" } },
      })

    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev-reasoning.json")))),
  )
})

// The fork's price cascade (fork/pricing.ts): zero-priced subscription rows resolve to the
// flagship they alias, so plan usage is priced instead of silently reading $0.
describe("fork pricing in the live catalog", () => {
  it.effect("keeps the declared prices of the shipped catalog, which is DeepSeek only", () =>
    Effect.gen(function* () {
      const service = yield* ModelsDev.Service
      const snapshot = yield* service.get()
      const row = (providerID: string, modelID: string) =>
        snapshot
          .find((entry) => String(entry.info.id) === providerID)
          ?.models.find((model) => String(model.id) === modelID)
      // declared prices stay untouched
      expect(row("deepseek", "deepseek-flash")?.cost[0]).toMatchObject({ input: 0.15, output: 0.6 })
      // the removed vendors cannot come back through the snapshot (ADR 0009)
      expect(row("alibaba-coding-plan", "qwen3.7-plus")).toBeUndefined()
      expect(row("xiaomi-token-plan-cn", "mimo-v2.6-pro")).toBeUndefined()
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "../../src/models-dev/snapshot.txt")))),
  )
})
