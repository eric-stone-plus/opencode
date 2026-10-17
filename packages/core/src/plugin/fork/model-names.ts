export * as ForkModelNamesPlugin from "./model-names.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { Effect, Option, Schema, Scope, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { App } from "../../app.js"
import { Config } from "../../config.js"
import { Provider } from "../../provider.js"

/**
 * Keeps model display names aligned with the provider's own `/models` metadata.
 *
 * models.dev is a snapshot (the fork pins `OPENCODE_DISABLE_MODELS_FETCH=1`), so
 * a server-side model upgrade can leave the picker showing the previous release
 * for days. DeepSeek's `GET /models` returns a `name` field intended for model
 * pickers, so refresh it at boot, every six hours, and whenever the config
 * changes. The last successful answer is cached in plugin storage, which keeps
 * the name correct before the first request of the next boot.
 *
 * A model whose provider config sets an explicit `name` is left alone: that is
 * a deliberate operator override, not a stale snapshot.
 */

const CACHE_KEY = "names"
const REFRESH_INTERVAL = "6 hours"
const REQUEST_TIMEOUT = "10 seconds"

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
})
const ModelList = Schema.Struct({
  data: Schema.Array(Model),
})
const Cache = Schema.Struct({
  updatedAt: Schema.Number,
  names: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
})
type Names = (typeof Cache.Type)["names"]

const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`

function explicitNames(entries: readonly Entry[]) {
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [providerID, provider] of Object.entries(entry.info.providers ?? {})) {
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (model.name !== undefined) names.add(key(providerID, modelID))
      }
    }
  }
  return names
}

function baseURL(settings: Provider.Info["settings"] | undefined) {
  const value = settings?.baseURL
  if (typeof value !== "string" || value.includes("${")) return
  return value.replace(/\/+$/, "")
}

function status(error: unknown) {
  return HttpClientError.isHttpClientError(error) ? error.response?.status : undefined
}

export const Plugin = define<Config.Service | HttpClient.HttpClient | Scope.Scope>({
  id: "fork.model-names",
  effect: (ctx) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const config = yield* Config.Service

      const stored = yield* ctx.storage.get(CACHE_KEY)
      const cached = Schema.decodeUnknownOption(Cache)(stored)
      let names: Names = Option.isSome(cached) ? cached.value.names : {}
      let explicit = explicitNames(yield* config.entries())

      yield* ctx.model.transform((editor) => {
        for (const model of editor.list()) {
          const remote = names[model.providerID]?.[model.modelID] ?? names[model.providerID]?.[model.id]
          if (remote === undefined) continue
          if (explicit.has(key(model.providerID, model.id)) || explicit.has(key(model.providerID, model.modelID)))
            continue
          if (model.name === remote) continue
          editor.update(model.providerID, model.id, (draft) => {
            draft.name = remote
          })
        }
      })

      const refresh = Semaphore.makeUnsafe(1)
        .withPermit(
          Effect.gen(function* () {
            const providers = (yield* ctx.provider.list()).data
            const next = { ...names }
            for (const provider of providers) {
              if (provider.activation === "disabled") continue
              const base = baseURL(provider.settings)
              if (base === undefined) continue
              const connection = yield* ctx.integration.connection.active(provider.integrationID ?? provider.id)
              const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
              if (credential?.type !== "key") continue
              const remote = yield* http
                .execute(
                  HttpClientRequest.get(`${base}/models`).pipe(
                    HttpClientRequest.setHeader("Authorization", `Bearer ${credential.key}`),
                    HttpClientRequest.setHeader("Accept", "application/json"),
                    HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
                  ),
                )
                .pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.text),
                  Effect.timeout(REQUEST_TIMEOUT),
                  Effect.flatMap((text) => Effect.try(() => JSON.parse(text))),
                  Effect.flatMap(Schema.decodeUnknownEffect(ModelList)),
                  Effect.map((response) =>
                    Object.fromEntries(
                      response.data.flatMap((item) => (item.name === undefined ? [] : [[item.id, item.name]])),
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.logDebug("model name refresh skipped", {
                      provider: provider.id,
                      status: status(error),
                    }).pipe(Effect.as(undefined)),
                  ),
                )
              if (remote !== undefined) next[provider.id] = remote
            }
            names = next
            yield* ctx.storage
              .set(CACHE_KEY, { updatedAt: Date.now(), names } satisfies Schema.Schema.Type<typeof Cache>)
              .pipe(Effect.catch(() => Effect.void))
            yield* ctx.model.reload()
          }),
        )
        .pipe(Effect.catchCause(() => Effect.logWarning("model name refresh failed")))

      yield* refresh.pipe(
        Effect.andThen(Effect.sleep(REFRESH_INTERVAL)),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            explicit = explicitNames(yield* config.entries())
            yield* refresh
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    }).pipe(Effect.catchCause(() => Effect.logWarning("model name plugin failed"))),
})
