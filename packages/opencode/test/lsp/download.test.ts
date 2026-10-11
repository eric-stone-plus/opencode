import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Npm } from "@opencode-ai/core/npm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as LSPServer from "@/lsp/server"
import { tmpdir, withTestInstance } from "../fixture/fixture"

// Servers that resolve a project-local module first and only then fall back to an npm install.
const gated = [
  { server: LSPServer.Typescript, seed: { "node_modules/typescript/lib/tsserver.js": "" } },
  {
    server: LSPServer.Biome,
    seed: { "node_modules/biome/package.json": '{"name":"biome","main":"x.js"}', "node_modules/biome/x.js": "" },
  },
]

const spawnWith = async (item: (typeof gated)[number], disableLspDownload: boolean) => {
  await using tmp = await tmpdir()
  await Promise.all(Object.entries(item.seed).map(([name, text]) => Bun.write(path.join(tmp.path, name), text)))
  const flags = await Effect.runPromise(
    RuntimeFlags.Service.use((value) => Effect.succeed(value)).pipe(
      Effect.provide(RuntimeFlags.layer({ disableLspDownload })),
    ),
  )
  // Awaited inside this scope so the temp project outlives the spawn.
  return await withTestInstance({ directory: tmp.path, fn: (ctx) => item.server.spawn(tmp.path, ctx, flags) })
}

const originalPath = process.env.PATH

// PATH holds only an empty directory, so the result never depends on servers installed on the machine running the test.
beforeEach(async () => {
  process.env.PATH = (await tmpdir()).path
})

afterEach(() => {
  process.env.PATH = originalPath
})

describe("lsp npm fallback honours OPENCODE_DISABLE_LSP_DOWNLOAD", () => {
  test("typescript uses a server already on PATH instead of installing one", async () => {
    const dir = process.env.PATH ?? ""
    const exe = path.join(dir, "typescript-language-server")
    await Bun.write(exe, "#!/bin/sh\nexec cat\n")
    await Bun.$`chmod +x ${exe}`.quiet()
    const which = spyOn(Npm, "which").mockResolvedValue(undefined)
    try {
      const handle = await spawnWith(gated[0], true)
      expect(handle?.process.spawnfile).toBe(exe)
      expect(which).not.toHaveBeenCalled()
      handle?.process.kill()
    } finally {
      which.mockRestore()
    }
  })

  for (const item of gated) {
    test(`${item.server.id} does not install from npm when downloads are disabled`, async () => {
      const which = spyOn(Npm, "which").mockResolvedValue(undefined)
      try {
        expect(await spawnWith(item, true)).toBeUndefined()
        expect(which).not.toHaveBeenCalled()
      } finally {
        which.mockRestore()
      }
    })

    test(`${item.server.id} still reaches npm when downloads are allowed`, async () => {
      const which = spyOn(Npm, "which").mockResolvedValue(undefined)
      try {
        await spawnWith(item, false)
        expect(which).toHaveBeenCalledTimes(1)
      } finally {
        which.mockRestore()
      }
    })
  }
})
