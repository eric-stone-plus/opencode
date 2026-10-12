import { describe, expect } from "bun:test"
import { LLM } from "@opencode/ai"
import { compileRequest } from "@opencode/ai/route/client"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { AISDKNative } from "@opencode/core/aisdk-native"
import { Compatibility, ID, Info, Model, VariantID } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { ModelResolver } from "@opencode/core/model-resolver"
import { AISDK } from "@opencode/core/aisdk"
import { it } from "./lib/effect"

interface ModelOptions {
  readonly providerID?: Provider.ID
  readonly canonical?: Provider.ID
  readonly modelID?: string
  readonly compatibility?: Compatibility
  readonly settings?: Info["settings"]
  readonly headers?: Info["headers"]
  readonly body?: Info["body"]
  readonly variants?: Info["variants"]
  readonly limit?: Info["limit"]
}

function model(packageName: string | undefined, options: ModelOptions = {}) {
  const info: Model.MutableInfo = {
    id: ID.make("test-model"),
    modelID: ID.make(options.modelID ?? "api-test-model"),
    providerID: options.providerID ?? Provider.ID.make("test-provider"),
    canonical: options.canonical,
    name: "Test model",
    compatibility: options.compatibility,
    package: packageName,
    settings: options.settings ?? {},
    headers: options.headers ?? { "x-test": "header" },
    body: options.body ?? { custom_extension: { enabled: true } },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: structuredClone(options.variants ?? []) as Model.MutableInfo["variants"],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: options.limit ?? { context: 100, output: 20 },
  }
  AISDKNative.rewrite(info, {
    specifier: packageName,
    providerID: info.providerID,
    canonical: info.canonical,
    modelID: info.modelID,
  })
  return Info.make(info)
}

function withEnv<A, E, R>(variables: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
      Object.entries(variables).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

describe("ModelResolver", () => {
  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          canonical: Provider.ID.make("deepseek"),
          compatibility: {
            reasoningField: "vendor_reasoning",
            requireReasoning: true,
            maxTokensField: "max_completion_tokens",
            requireFinishReason: false,
            requireAssistantAfterTool: true,
          },
          settings: {
            apiKey: "settings-secret",
            baseURL: "https://compatible.example/v1",
            compatibility: "strict",
          },
          headers: {},
          body: {},
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello", generation: { maxTokens: 10 } })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.id).toBe("openai-compatible-chat")
      expect(String(resolved.provider)).toBe("deepseek")
      expect(resolved.route.providerMetadataKey).toBe("deepseek")
      expect(resolved.compatibility?.reasoningField).toBe("vendor_reasoning")
      expect(resolved.compatibility?.requireReasoning).toBe(true)
      expect(resolved.compatibility?.maxTokensField).toBe("max_completion_tokens")
      expect(resolved.compatibility?.requireFinishReason).toBe(false)
      expect(resolved.compatibility?.requireAssistantAfterTool).toBe(true)
      expect(prepared.body).toMatchObject({ max_completion_tokens: 10 })
      expect(prepared.body).not.toHaveProperty("max_tokens")
      expect(resolved.route.endpoint.baseURL).toBe("https://compatible.example/v1")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("resolves provider URLs from environment without mutating the catalog model", () =>
    withEnv({ ACME_HOST: "api.acme.test" }, () =>
      Effect.gen(function* () {
        const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          settings: { baseURL: "https://${ACME_HOST}/v1" },
        })
        const resolved = yield* ModelResolver.fromCatalogModel(catalog)

        expect(resolved.route.endpoint.baseURL).toBe("https://api.acme.test/v1")
        expect(catalog.settings?.baseURL).toBe("https://${ACME_HOST}/v1")
      }),
    ),
  )

  it.effect("rejects unresolved variables in constructed provider routes", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai-compatible"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/${REQUIRED_PATH}/v1" },
          }),
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          providerID: "test-provider",
          modelID: "test-model",
          variables: ["REQUIRED_HOST", "REQUIRED_PATH"],
        })
        expect(failure.message).toBe(
          "Cannot initialize test-provider/test-model: REQUIRED_HOST, REQUIRED_PATH are required to resolve the provider endpoint",
        )
      }),
    ),
  )

  it.effect("overlays selected OpenAI-compatible variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
        settings: { baseURL: "https://compatible.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: {},
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("rejects an explicit unavailable variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
      })
      const failure = yield* ModelResolver.resolveModel(catalog, VariantID.make("unknown")).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("unset and default variants resolve to the ladder top", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
        settings: { baseURL: "https://compatible.example/v1" },
        variants: [
          { id: VariantID.make("low"), settings: {}, headers: {}, body: { reasoning_effort: "low" } },
          { id: VariantID.make("max"), settings: {}, headers: {}, body: { reasoning_effort: "max" } },
        ],
      })
      // Unset: the ladder top overlay runs, so effort never falls to the
      // provider's default by omission (2026-10-10 policy).
      const fallback = yield* ModelResolver.resolveModel(catalog, undefined)
      expect(fallback.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        reasoning_effort: "max",
      })
      // The `default` sentinel means the same thing when the ladder defines no real default tier.
      const sentinel = yield* ModelResolver.resolveModel(catalog, VariantID.make("default"))
      expect(sentinel.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        reasoning_effort: "max",
      })
      // Explicit picks are still honored.
      const explicit = yield* ModelResolver.resolveModel(catalog, VariantID.make("low"))
      expect(explicit.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        reasoning_effort: "low",
      })
    }),
  )

  it.effect("overlays selected Anthropic variant settings", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/anthropic"), {
        settings: { baseURL: "https://anthropic.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: { thinking: { type: "enabled", budgetTokens: 12000 } },
            headers: {},
            body: {},
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
      })
      expect(resolved.route.defaults.providerOptions).toEqual({
        thinking: { type: "enabled", budgetTokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/anthropic"), {
          settings: { baseURL: "https://anthropic.example/v1" },
        }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        providerMetadataKey: "anthropic",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("rejects unresolved variables before loading opaque AISDK packages", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/perplexity"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["REQUIRED_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects placeholders introduced by environment expansion before loading providers", () =>
    withEnv({ PROVIDER_HOST: "${MISSING_HOST}", MISSING_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/perplexity"), {
            settings: { baseURL: "https://${PROVIDER_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["MISSING_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects AISDK packages without an available loader", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/perplexity"), {
          settings: { baseURL: "https://perplexity.example/v1" },
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedPackageError",
        providerID: "test-provider",
        modelID: "test-model",
        package: "aisdk:@ai-sdk/perplexity",
      })
      expect(failure.message).toBe("Unsupported package for test-provider/test-model: aisdk:@ai-sdk/perplexity")
    }),
  )

  it.effect("distinguishes unexpected constructor failures from configuration errors", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: () =>
          Effect.succeed({
            model: () => {
              throw new Error("custom provider crashed")
            },
          }),
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "construct",
        detail: "custom provider crashed",
      })
    }),
  )

  it.effect("reports package load and AISDK initialization failures with their causes", () =>
    Effect.gen(function* () {
      const load = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: (specifier) =>
          Effect.fail(
            new Provider.LoadError({ package: specifier, cause: new Error(`Provider package ${specifier} is broken`) }),
          ),
      }).pipe(Effect.flip)
      expect(load).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "load",
        detail: "Provider package @opencode/ai/providers/custom is broken",
      })

      const init = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/perplexity")), undefined, {
        loadAISDK: (runtime) =>
          Effect.fail(
            new AISDK.InitError({ providerID: runtime.providerID, cause: new Error("Perplexity plugin failed") }),
          ),
      }).pipe(Effect.flip)
      expect(init).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "init",
        detail: "Perplexity plugin failed",
      })
      expect(init.message).toBe("Cannot initialize test-provider/test-model: Perplexity plugin failed")
    }),
  )

  it.effect("reports whether a catalog model declares a provider package", () =>
    Effect.sync(() => {
      expect(ModelResolver.hasPackage(model(Provider.aisdk("@ai-sdk/openai")))).toBe(true)
      expect(ModelResolver.hasPackage(model("@opencode/ai/providers/custom"))).toBe(true)
      expect(ModelResolver.hasPackage(model(undefined))).toBe(false)
    }),
  )
})
