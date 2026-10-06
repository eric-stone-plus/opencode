import { describe, expect, mock } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

// fff is an optimization: when its init fails the service must fall back to
// ripgrep instead of answering empty for every find/glob/grep (7432798c38).
// The counter makes the test fail loudly if the mock stops intercepting —
// a real fff create() success would silently turn this into a false pass.
let createCalls = 0
mock.module("#fff", () => ({
  Fff: {
    available: () => true,
    create: () => {
      createCalls += 1
      return { ok: false, error: "injected fff init failure" }
    },
  },
}))

const { FileSystemSearch } = await import("@opencode-ai/core/filesystem/search")

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystemSearch.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

describe("fff fallback", () => {
  it.live("falls back to ripgrep when fff init fails, instead of returning empty", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "match.ts"), "needle\n"))
        const service = yield* FileSystemSearch.Service
        const found = yield* service.glob({ pattern: "**/*.ts", limit: 10 })
        expect(createCalls).toBeGreaterThan(0)
        expect(found.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }).pipe(provide(directory)),
    ),
  )
})
