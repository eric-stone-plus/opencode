import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { DeclaredProvidersPlugin } from "@opencode-ai/core/plugin/provider/declared"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const decode = Schema.decodeUnknownSync(Config.Info)

const configWith = (providers: Record<string, unknown> | undefined) =>
  Config.Service.of({
    entries: () =>
      Effect.succeed(providers ? [new Config.Document({ type: "document", info: decode({ providers }) })] : []),
  } as unknown as Config.Interface)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* DeclaredProvidersPlugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

const seed = Effect.fn(function* () {
  const catalog = yield* Catalog.Service
  yield* catalog.transform((draft) => {
    // Simulates models.dev / env discovery adding free or undeclared providers.
    for (const [providerID, models] of [
      ["openrouter", ["free-model"]],
      ["anthropic", ["claude-haiku"]],
      ["zhipuai-coding-plan", ["glm-5.3", "glm-4.7"]],
      ["xiaomi-token-plan-cn", ["mimo-v2.6-pro", "mimo-v2-flash"]],
    ] as const) {
      draft.provider.update(ProviderV2.ID.make(providerID), () => {})
      for (const modelID of models) draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), () => {})
    }
  })
  return catalog
})

describe("DeclaredProvidersPlugin", () => {
  it.effect("drops every provider the config does not declare", () =>
    Effect.gen(function* () {
      const catalog = yield* seed()
      yield* addPlugin(
        configWith({
          "zhipuai-coding-plan": { models: { "glm-5.3": {} } },
          "xiaomi-token-plan-cn": {},
        }),
      )
      const ids = (yield* catalog.provider.all()).map((item) => String(item.id)).sort()
      expect(ids).toEqual(["xiaomi-token-plan-cn", "zhipuai-coding-plan"])
    }),
  )

  it.effect("treats a non-empty models block as the exhaustive model list", () =>
    Effect.gen(function* () {
      const catalog = yield* seed()
      yield* addPlugin(
        configWith({
          "zhipuai-coding-plan": { models: { "glm-5.3": {} } },
          "xiaomi-token-plan-cn": {},
        }),
      )
      const models = (yield* catalog.model.all()).map((item) => `${item.providerID}/${item.id}`).sort()
      expect(models).toEqual([
        "xiaomi-token-plan-cn/mimo-v2-flash",
        "xiaomi-token-plan-cn/mimo-v2.6-pro",
        "zhipuai-coding-plan/glm-5.3",
      ])
    }),
  )

  it.effect("leaves the catalog empty when nothing is declared", () =>
    Effect.gen(function* () {
      const catalog = yield* seed()
      yield* addPlugin(configWith(undefined))
      expect(yield* catalog.provider.all()).toEqual([])
      expect(yield* catalog.model.default()).toBeUndefined()
    }),
  )
})

describe("DeclaredProvidersPlugin api precedence", () => {
  it.effect("declared provider api overrides per-model registry api unless the model pins its own", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("zhipuai-coding-plan")
      yield* catalog.transform((draft) => {
        draft.provider.update(providerID, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://user.example.com/v1" }
        })
        for (const modelID of ["glm-5.3", "glm-pinned"]) {
          draft.model.update(providerID, ModelV2.ID.make(modelID), (model) => {
            model.api = {
              id: ModelV2.ID.make(modelID),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://registry.example.com/v4",
            }
          })
        }
      })
      yield* addPlugin(
        configWith({
          "zhipuai-coding-plan": {
            api: { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://user.example.com/v1" },
            models: {
              "glm-5.3": {},
              "glm-pinned": {
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://registry.example.com/v4" },
              },
            },
          },
        }),
      )
      const model = required(yield* catalog.model.get(providerID, ModelV2.ID.make("glm-5.3")))
      expect(model.api).toMatchObject({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://user.example.com/v1" })
      expect(String(model.api.id)).toBe("glm-5.3")
      const pinned = required(yield* catalog.model.get(providerID, ModelV2.ID.make("glm-pinned")))
      expect(pinned.api).toMatchObject({ package: "@ai-sdk/openai-compatible", url: "https://registry.example.com/v4" })
    }),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}
