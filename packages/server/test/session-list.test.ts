import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("returns a 400 for an invalid session cursor", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const response = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/session?cursor=not-a-cursor")),
    )
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "InvalidCursorError" })
  }).pipe(Effect.scoped),
)
