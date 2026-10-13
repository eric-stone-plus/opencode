import { describe, expect } from "bun:test"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { Config } from "@opencode/core/config"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { DeclaredProvidersPlugin } from "@opencode/core/plugin/fork/declared-providers"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)
const document = (providers: Record<string, unknown>) => new Document({ type: "document", info: decode({ providers }) })

const addPlugins = Effect.fn(function* (entries: Entry[]) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
  yield* DeclaredProvidersPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
})

// Simulates models.dev and env discovery registering every supported vendor.
const seed = Effect.fn(function* () {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) => {
    for (const [providerID, models] of [
      ["alibaba", ["qwen-plus"]],
      ["deepseek", ["deepseek-flash", "deepseek-pro"]],
      ["alibaba-coding-plan", ["qwen3.8-max", "qwen3.7-plus"]],
      ["xiaomi-token-plan-cn", ["mimo-v2.6-pro", "mimo-v2-flash"]],
    ] as const) {
      editor.update(Provider.ID.make(providerID), () => {})
      for (const modelID of models) editor.models.update(Provider.ID.make(providerID), Model.ID.make(modelID), () => {})
    }
  })
  return providers
})

const catalog = Effect.fn(function* (providers: Provider.Interface) {
  const snapshot = yield* providers.snapshot()
  return Array.from(snapshot.records.values())
    .flatMap((record) => Array.from(record.models.keys(), (modelID) => `${record.provider.id}/${modelID}`))
    .toSorted()
})

describe("DeclaredProvidersPlugin", () => {
  it.effect("drops every provider the config does not declare", () =>
    Effect.gen(function* () {
      const providers = yield* seed()
      yield* addPlugins([
        document({ "alibaba-coding-plan": { models: { "qwen3.8-max": {} } }, "xiaomi-token-plan-cn": {} }),
      ])
      expect((yield* providers.all()).map((item) => String(item.id)).toSorted()).toEqual([
        "alibaba-coding-plan",
        "xiaomi-token-plan-cn",
      ])
    }),
  )

  it.effect("treats a non-empty models block as the exhaustive model list", () =>
    Effect.gen(function* () {
      const providers = yield* seed()
      yield* addPlugins([
        document({ "alibaba-coding-plan": { models: { "qwen3.8-max": {} } }, "xiaomi-token-plan-cn": {} }),
      ])
      expect(yield* catalog(providers)).toEqual([
        "alibaba-coding-plan/qwen3.8-max",
        "xiaomi-token-plan-cn/mimo-v2-flash",
        "xiaomi-token-plan-cn/mimo-v2.6-pro",
      ])
    }),
  )

  it.effect("keeps a declared alias of a registry model without keeping its siblings", () =>
    Effect.gen(function* () {
      const providers = yield* seed()
      yield* addPlugins([document({ deepseek: { models: { fast: { modelID: "deepseek-flash" } } } })])
      expect(yield* catalog(providers)).toEqual(["deepseek/fast"])
    }),
  )

  it.effect("leaves the catalog empty when nothing is declared", () =>
    Effect.gen(function* () {
      const providers = yield* seed()
      yield* addPlugins([])
      expect(yield* providers.all()).toEqual([])
    }),
  )

  it.effect("merges the models declared across config documents", () =>
    Effect.gen(function* () {
      const providers = yield* seed()
      yield* addPlugins([
        document({ deepseek: { models: { "deepseek-flash": {} } } }),
        document({ deepseek: { models: { "deepseek-pro": {} } } }),
      ])
      expect(yield* catalog(providers)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-pro"])
    }),
  )
})
