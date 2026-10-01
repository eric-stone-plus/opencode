import { Effect } from "effect"
import { Config } from "../../config"
import { define } from "../internal"

// Fork policy: the catalog only ever contains providers declared in the config `providers`
// block (v1 `provider` migrates into it). models.dev, env-var integrations and provider plugins
// may enrich a declared provider but never add one. When a declared provider lists models, that
// list is exhaustive: undeclared registry models are dropped so nothing can auto-select them.
// Registered after every other built-in catalog transform so it sees their final output.
export const DeclaredProvidersPlugin = define({
  id: "declared-providers",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const declared = new Map<string, { models: Set<string>; api: boolean; modelApi: Set<string> }>()
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const entry = declared.get(id) ?? { models: new Set<string>(), api: false, modelApi: new Set<string>() }
            if (item.api !== undefined) entry.api = true
            for (const [modelID, model] of Object.entries(item.models ?? {})) {
              entry.models.add(modelID)
              if (model.api !== undefined) entry.modelApi.add(modelID)
            }
            declared.set(id, entry)
          }
        }
        for (const record of [...catalog.provider.list()]) {
          const providerID = record.provider.id
          const entry = declared.get(providerID)
          if (!entry) {
            catalog.provider.remove(providerID)
            continue
          }
          for (const modelID of [...record.models.keys()]) {
            if (entry.models.size > 0 && !entry.models.has(modelID)) {
              catalog.model.remove(providerID, modelID)
              continue
            }
            // A declared provider-level adapter/endpoint beats per-model registry overrides
            // unless the user pinned that model's api explicitly.
            if (!entry.api || entry.modelApi.has(modelID)) continue
            catalog.model.update(providerID, modelID, (model) => {
              model.api = { ...structuredClone(record.provider.api), id: model.api.id }
            })
          }
        }
      }),
    )
  }),
})
