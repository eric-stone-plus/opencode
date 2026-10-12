export * as DeclaredProvidersPlugin from "./declared-providers.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"

// Fork policy (ADR 0003): only providers declared in the config `providers` block exist. models.dev, env-var
// integrations, stored credentials and provider plugins may enrich a declared provider, but never add one, and
// a declared provider with a non-empty `models` block exposes exactly those models. Registered after every other
// catalog transform (it follows the config provider plugin) so it sees their final output.
export const Plugin = define({
  id: "fork.declared-providers",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.provider.reload())
    yield* ctx.provider.transform((providers) => {
      const declared = new Map<string, Set<string>>()
      for (const entry of loaded.entries) {
        if (entry.type !== "document") continue
        for (const [providerID, provider] of Object.entries(entry.info.providers ?? {}))
          declared.set(
            providerID,
            new Set([...(declared.get(providerID) ?? []), ...Object.keys(provider.models ?? {})]),
          )
      }
      for (const record of providers.list()) {
        const providerID = record.provider.id
        const models = declared.get(providerID)
        if (!models) {
          providers.remove(providerID)
          continue
        }
        if (models.size === 0) continue
        for (const modelID of record.models.keys())
          if (!models.has(modelID)) providers.models.remove(providerID, modelID)
      }
    })
  }),
})
