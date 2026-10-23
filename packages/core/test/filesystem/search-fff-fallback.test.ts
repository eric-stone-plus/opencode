import { describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { Location } from "@opencode/core/location"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { FileSystem } from "@opencode/schema/filesystem"
import { location } from "../fixture/location"
import { it } from "../lib/effect"

// fff is an optimization, never the only search backend. A nonexistent basePath
// makes the real fff backend refuse initialization on every platform, so this
// test needs neither the native library nor mock.module (which leaks across
// core's single-process suite). If fff ever accepts the path, the ripgrep stub
// below is never consulted and the assertions fail instead of passing silently.
describe("fff fallback", () => {
  it.effect("falls back to ripgrep when fff init fails, instead of returning empty", () => {
    const directory = path.join(os.tmpdir(), `opencode-fff-fallback-${randomUUID()}`)
    let observed: Ripgrep.FindInput | undefined
    const ripgrep = Layer.succeed(
      Ripgrep.Service,
      Ripgrep.Service.of({
        find: (input) =>
          Effect.gen(function* () {
            observed = input
            const entry = FileSystem.Entry.make({
              path: RelativePath.make("src/fallback.ts"),
              type: "file",
            })
            if (input.onEntry) yield* input.onEntry(entry)
            return [entry]
          }),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
      }),
    )
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    const layer = FileSystemSearch.fffLayer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(Location.Service, Location.Service.of(location(ref))),
          ripgrep,
        ),
      ),
    )

    return Effect.gen(function* () {
      const service = yield* FileSystemSearch.Service
      const found = yield* service.find({ query: "fallback", type: "file" })

      expect(observed?.cwd).toBe(directory)
      expect(found.map((entry) => entry.path)).toEqual([RelativePath.make("src/fallback.ts")])
    }).pipe(Effect.provide(layer))
  })
})
