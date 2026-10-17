export * as ForkSearchPlugin from "./search.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { HttpClient } from "effect/http"
import { search } from "../../deepseek.js"

/**
 * Registers DeepSeek's native Search API as the fork's only web-search provider.
 *
 * The provider is added in the post phase, after `ConfigWebSearchPlugin` has
 * applied the configured selection. If the config does not choose a provider,
 * DeepSeek becomes the default so the tool never has to open a consent form.
 */
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "fork.websearch.deepseek",
  effect: (ctx) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      yield* ctx.websearch.transform((editor) => {
        editor.add({
          id: "deepseek",
          name: "DeepSeek Search",
          execute: (input) => search(ctx, http, input.query),
        })
        if (editor.default.get() === undefined) editor.default.set("deepseek")
      })
    }),
})
