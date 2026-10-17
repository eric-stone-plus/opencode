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
const RETRY_INTERVAL = "1 minute"
const REQUEST_TIMEOUT = "10 seconds"
const MAX_RESPONSE_BYTES = 1_000_000
const DEEPSEEK = "deepseek"
const DEEPSEEK_HOST = "api.deepseek.com"
const DEFAULT_BASE_URL = "https://api.deepseek.com"

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
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

/**
 * The fork is DeepSeek-only (ADR 0009), and the key may only travel to DeepSeek's own
 * endpoint: a project config that re-points `baseURL` must not turn the refresh into a
 * credential exfiltration request. Unknown hosts, protocols, paths and templates skip.
 */
function baseURL(settings: Provider.Info["settings"] | undefined) {
  const value = settings?.baseURL
  if (value === undefined) return DEFAULT_BASE_URL
  if (typeof value !== "string" || value.includes("${")) return
  const url = URL.parse(value)
  if (url === null) return
  if (url.protocol !== "https:" || url.hostname !== DEEPSEEK_HOST) return
  if (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/") return
  return value.replace(/\/+$/, "")
}

/** Display names land in the model picker and the system prompt; reject control characters. */
function displayName(value: string | null | undefined) {
  if (value === null || value === undefined) return
  const name = value.trim()
  if (name.length === 0 || name.length > 80) return
  if (!/^[\p{L}\p{N} ._()+-]+$/u.test(name)) return
  return name
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
            let fetched = false
            for (const provider of providers) {
              if (provider.id !== DEEPSEEK) continue
              if (provider.activation === "disabled") continue
              const base = baseURL(provider.settings)
              if (base === undefined) continue
              const connection = yield* ctx.integration.connection.active(provider.integrationID ?? provider.id)
              // Resolving an OAuth connection can refresh its token and publish credential.updated,
              // which would re-enter this refresh; a display-name sync must not touch OAuth at all.
              if (connection?.type === "credential" && connection.method !== "key") continue
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
                  Effect.flatMap((text) =>
                    text.length > MAX_RESPONSE_BYTES
                      ? Effect.fail(new Error("model list response too large"))
                      : Effect.succeed(text),
                  ),
                  Effect.flatMap((text) => Effect.try(() => JSON.parse(text))),
                  Effect.flatMap(Schema.decodeUnknownEffect(ModelList)),
                  Effect.map((response) =>
                    Object.fromEntries(
                      response.data.flatMap((item) => {
                        const name = displayName(item.name)
                        return name === undefined ? [] : [[item.id, name]]
                      }),
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.logDebug("model name refresh skipped", {
                      provider: provider.id,
                      status: status(error),
                    }).pipe(Effect.as(undefined)),
                  ),
                )
              if (remote !== undefined) {
                next[provider.id] = remote
                fetched = true
              }
            }
            names = next
            // Apply the name even when the cache write fails: KV.set dies on storage errors,
            // and a dying write must not skip the reload that publishes the new name.
            yield* ctx.model.reload()
            yield* ctx.storage
              .set(CACHE_KEY, { updatedAt: Date.now(), names } satisfies Schema.Schema.Type<typeof Cache>)
              .pipe(Effect.catchCause(() => Effect.void))
            return fetched
          }),
        )
        .pipe(Effect.catchCause(() => Effect.logWarning("model name refresh failed")))

      yield* Effect.gen(function* () {
        const fetched = yield* refresh
        // Before the provider/credential is ready the first pass is a no-op; retry soon
        // instead of leaving the stale name in place for six hours.
        yield* Effect.sleep(fetched ? REFRESH_INTERVAL : RETRY_INTERVAL)
      }).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }))

      yield* ctx.event.subscribe().pipe(
        Stream.filter(
          (event) =>
            event.type === "config.updated" ||
            event.type === "provider.updated" ||
            event.type === "credential.updated" ||
            event.type === "credential.switched",
        ),
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
