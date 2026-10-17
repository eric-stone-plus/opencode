import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { ForkSearchPlugin } from "@opencode/core/plugin/fork/search"
import { TestWebSearch } from "../../lib/websearch"
import { testEffect } from "../../lib/effect"
import { host, webSearchHost } from "../host"

const it = testEffect(TestWebSearch.layer)

const http = HttpClient.make(() => Effect.die("unused http client"))

describe("ForkSearchPlugin", () => {
  it.effect("registers DeepSeek as the default search provider", () =>
    Effect.gen(function* () {
      const websearch = yield* TestWebSearch.Service
      const ctx = host({ websearch: webSearchHost(websearch) })

      yield* ForkSearchPlugin.Plugin.effect(ctx).pipe(Effect.provideService(HttpClient.HttpClient, http))

      expect((yield* websearch.providers()).map((provider) => String(provider.id))).toEqual(["deepseek"])
      expect(yield* websearch.default()).toMatchObject({ id: "deepseek", name: "DeepSeek Search" })
    }),
  )
})
