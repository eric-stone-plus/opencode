import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode/core/schema"
import { ForkDeepSeekBaseURLPlugin } from "@opencode/core/plugin/fork/base-url"
import { Effect } from "effect"
import { it } from "../../lib/effect"
import { host } from "../host"

const location = { directory: AbsolutePath.make("/workspace") }

const provider = (id: string, baseURL: string) =>
  ({
    id,
    name: id,
    activation: "enabled",
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL },
  }) as any

describe("ForkDeepSeekBaseURLPlugin", () => {
  it.effect("pins the DeepSeek chat base URL and leaves other providers alone", () =>
    Effect.gen(function* () {
      const deepseek = provider("deepseek", "https://api.deepseek.com/anthropic")
      const other = provider("other", "https://other.example")
      const providers = [deepseek, other]
      const ctx = host({
        provider: {
          list: () => Effect.succeed({ location, data: providers }),
          get: () => Effect.die("unused provider.get"),
          transform: (callback) =>
            Effect.sync(() => {
              callback({
                get: (id: string) => providers.find((item) => item.id === id),
                update: (id: string, update: (draft: any) => void) => {
                  const item = providers.find((value) => value.id === id)
                  if (item) update(item)
                },
              } as any)
              return { dispose: Effect.void }
            }),
          reload: () => Effect.void,
        },
      })

      yield* ForkDeepSeekBaseURLPlugin.Plugin.effect(ctx)

      expect(deepseek.settings.baseURL).toBe("https://api.deepseek.com")
      expect(other.settings.baseURL).toBe("https://other.example")
    }),
  )
})
