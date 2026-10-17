import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode/core/schema"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { ForkModelNamesPlugin } from "@opencode/core/plugin/fork/model-names"
import { Document } from "@opencode/schema/config"
import { Deferred, Effect, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { host } from "../host"
import { it } from "../../lib/effect"

const location = { directory: AbsolutePath.make("/workspace") }

const provider = {
  id: "deepseek",
  name: "DeepSeek",
  activation: "enabled" as const,
  package: "@ai-sdk/openai-compatible",
  settings: { baseURL: "https://api.deepseek.com" },
}

function models(initial: { name: string }[] = [{ name: "DeepSeek-V4.1-Flash" }], reloaded?: Deferred.Deferred<void>) {
  const data = initial.map((model) => ({
    id: "deepseek-flash",
    modelID: "deepseek-flash",
    providerID: "deepseek",
    name: model.name,
  }))
  const transforms: Array<(editor: any) => void> = []
  const editor = {
    list: () => data,
    get: (providerID: string, modelID: string) =>
      data.find((model) => model.providerID === providerID && model.id === modelID),
    update: (providerID: string, modelID: string, update: (model: any) => void) => {
      const model = data.find((item) => item.providerID === providerID && item.id === modelID)
      if (model) update(model)
    },
    remove: () => {},
    default: { get: () => undefined, set: () => {} },
    provider: { list: () => [], get: () => undefined },
  }
  return {
    data,
    domain: {
      list: () => Effect.succeed({ location, data }),
      default: () => Effect.succeed({ location, data: undefined }),
      transform: (callback: (editor: any) => void) =>
        Effect.sync(() => {
          transforms.push(callback)
          callback(editor)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.gen(function* () {
          for (const transform of transforms) transform(editor)
          if (reloaded) yield* Deferred.succeed(reloaded, undefined)
        }),
    } as any,
  }
}

const storage = (values = new Map<string, unknown>(), saved?: Deferred.Deferred<void>) =>
  ({
    get: (key: string) => Effect.succeed(values.get(key)),
    set: (key: string, value: unknown) =>
      Effect.gen(function* () {
        values.set(key, value)
        if (saved) yield* Deferred.succeed(saved, undefined)
      }),
    remove: (key: string) => Effect.sync(() => void values.delete(key)),
    scan: () => Effect.succeed([]),
  }) as any

const http = (body: string, status = 200, requests: string[] = [], headers: Record<string, string>[] = []) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url)
      headers.push(request.headers)
    }).pipe(Effect.andThen(Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))))),
  )

const context = (input: {
  model: ReturnType<typeof models>
  storage: ReturnType<typeof storage>
  providers?: unknown[]
}) =>
  host({
    app: { name: "test", version: "test", channel: "test" },
    provider: {
      list: () => Effect.succeed({ location, data: (input.providers ?? [provider]) as any }),
      get: () => Effect.die("unused provider.get"),
      transform: () => Effect.die("unused provider.transform"),
      reload: () => Effect.void,
    },
    model: input.model.domain,
    integration: {
      ...host().integration,
      connection: {
        active: () => Effect.succeed({ type: "credential", id: "cred", label: "key", method: "key" } as any),
        resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
        status: () => Effect.die("unused connection.status"),
      },
    },
    storage: input.storage,
    event: { subscribe: () => Stream.empty },
  })

describe("ForkModelNamesPlugin", () => {
  it.effect("applies the remote display name and caches it", () =>
    Effect.gen(function* () {
      const reloaded = yield* Deferred.make<void>()
      const saved = yield* Deferred.make<void>()
      const model = models(undefined, reloaded)
      const values = new Map<string, unknown>()
      const requests: string[] = []
      const headers: Record<string, string>[] = []
      const body = JSON.stringify({
        object: "list",
        data: [
          { id: "other", name: null },
          { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash-1017" },
        ],
      })
      const mock = http(body, 200, requests, headers)
      const ctx = context({ model, storage: storage(values, saved) })

      yield* ForkModelNamesPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Config.testLayer([])),
        Effect.provideService(HttpClient.HttpClient, mock),
        Effect.forkScoped({ startImmediately: true }),
      )

      // The refresh fiber reloads the model state before writing the cache.
      yield* Deferred.await(reloaded)
      yield* Deferred.await(saved)

      expect(model.data[0]?.name).toBe("DeepSeek-V4.1-Flash-1017")
      expect(requests).toEqual(["https://api.deepseek.com/models"])
      expect(headers[0]?.authorization).toBe("Bearer secret")
      expect(values.get("names")).toMatchObject({
        names: { deepseek: { "deepseek-flash": "DeepSeek-V4.1-Flash-1017" } },
      })
    }).pipe(Effect.scoped),
  )

  it.effect("uses the cached name before the first refresh succeeds", () =>
    Effect.gen(function* () {
      const model = models()
      const values = new Map<string, unknown>([
        ["names", { updatedAt: Date.now(), names: { deepseek: { "deepseek-flash": "Cached-Name" } } }],
      ])
      const mock = http("nope", 500)
      const ctx = context({ model, storage: storage(values) })

      yield* ForkModelNamesPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Config.testLayer([])),
        Effect.provideService(HttpClient.HttpClient, mock),
        Effect.forkScoped({ startImmediately: true }),
      )

      expect(model.data[0]?.name).toBe("Cached-Name")
    }).pipe(Effect.scoped),
  )

  it.effect("keeps an explicit provider-config name", () =>
    Effect.gen(function* () {
      const reloaded = yield* Deferred.make<void>()
      const model = models([{ name: "Pinned-Name" }], reloaded)
      const values = new Map<string, unknown>()
      const requests: string[] = []
      const body = JSON.stringify({ data: [{ id: "deepseek-flash", name: "Remote-Name" }] })
      const ctx = context({ model, storage: storage(values) })
      const entries = [
        new Document({
          type: "document",
          info: {
            providers: { deepseek: { models: { "deepseek-flash": { name: "Pinned-Name" } } } },
          } as any,
        }),
      ]

      yield* ForkModelNamesPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Config.testLayer(entries)),
        Effect.provideService(HttpClient.HttpClient, http(body, 200, requests)),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Deferred.await(reloaded)

      expect(requests).toEqual(["https://api.deepseek.com/models"])
      expect(model.data[0]?.name).toBe("Pinned-Name")
    }).pipe(Effect.scoped),
  )

  it.effect("ignores a non-DeepSeek base URL and still refreshes from the official endpoint", () =>
    Effect.gen(function* () {
      const reloaded = yield* Deferred.make<void>()
      const model = models(undefined, reloaded)
      const requests: string[] = []
      const ctx = context({
        model,
        storage: storage(),
        providers: [{ ...provider, settings: { baseURL: "https://evil.example" } }],
      })
      const body = JSON.stringify({ data: [{ id: "deepseek-flash", name: "Remote-Name" }] })

      yield* ForkModelNamesPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Config.testLayer([])),
        Effect.provideService(HttpClient.HttpClient, http(body, 200, requests)),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Deferred.await(reloaded)

      expect(requests).toEqual(["https://api.deepseek.com/models"])
      expect(model.data[0]?.name).toBe("Remote-Name")
    }).pipe(Effect.scoped),
  )
})
