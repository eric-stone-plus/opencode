import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { tmpdir, withTestInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { LSPClient } from "@/lsp/client"
import { LSP, restartDelay } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

function spawnFakeServer() {
  const { spawn } = require("child_process")
  return { process: spawn(process.execPath, [fakeServerPath], { stdio: "pipe" }) } as unknown as LSPServer.Handle
}

async function withClient(fn: (client: LSPClient.Info, dir: string) => Promise<void>) {
  await using tmp = await tmpdir()
  await withTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const client = await LSPClient.create({
        serverID: "fake",
        server: spawnFakeServer(),
        root: tmp.path,
        directory: tmp.path,
        instance: ctx,
      })
      try {
        await fn(client, tmp.path)
      } finally {
        await client.shutdown()
      }
    },
  })
}

describe("LSPClient resilience", () => {
  test("requests to a hung server time out", async () => {
    await withClient(async (client) => {
      const started = Date.now()
      await expect(client.request("test/hang", {}, 200)).rejects.toThrow(/timed out/)
      expect(Date.now() - started).toBeLessThan(5_000)
    })
  })

  test("marks the client dead when the server process exits", async () => {
    await withClient(async (client) => {
      const dead = new Promise<void>((resolve) => client.onDead(resolve))
      await client.connection.sendNotification("test/exit", {})
      await dead
      expect(client.alive).toBe(false)
      await expect(client.request("textDocument/hover", {})).rejects.toThrow(/not running/)
    })
  })

  test("shutdown does not report the client as dead", async () => {
    await withClient(async (client) => {
      let fired = false
      client.onDead(() => {
        fired = true
      })
      await client.shutdown()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(fired).toBe(false)
    })
  })

  test("closes least recently used documents beyond the limit", async () => {
    await withClient(async (client, dir) => {
      const files = Array.from({ length: LSPClient.MAX_OPEN_DOCUMENTS + 1 }, (_, i) => path.join(dir, `f${i}.ts`))
      await Promise.all(files.map((file) => Bun.write(file, "x\n")))
      await client.notify.open({ path: files[0] })
      await client.notify.open({ path: files[1] })
      // Touch the first file again so the second becomes the oldest.
      await client.notify.open({ path: files[0] })
      for (const file of files.slice(2)) await client.notify.open({ path: file })

      const open = client.openDocuments
      expect(open.length).toBe(LSPClient.MAX_OPEN_DOCUMENTS)
      expect(open).toContain(files[0])
      expect(open).not.toContain(files[1])
      expect(open).toContain(files[2])

      const closed = await client.request<string[]>("test/get-closed", {})
      expect(closed).toEqual([pathToFileURL(files[1]).href])
    })
  })

  test("evicted documents drop their diagnostics", async () => {
    await withClient(async (client, dir) => {
      const first = path.join(dir, "first.ts")
      await Bun.write(first, "x\n")
      await client.notify.open({ path: first })
      await client.connection.sendNotification("test/publish-diagnostics", {
        uri: pathToFileURL(first).href,
        diagnostics: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "boom", severity: 1 },
        ],
      })
      await client.request("test/get-closed", {})
      expect(client.diagnostics.get(first)?.length).toBe(1)

      for (let i = 0; i < LSPClient.MAX_OPEN_DOCUMENTS; i++) {
        const file = path.join(dir, `g${i}.ts`)
        await Bun.write(file, "x\n")
        await client.notify.open({ path: file })
      }
      expect(client.diagnostics.has(first)).toBe(false)
    })
  })
})

describe("LSP restart policy", () => {
  test("restarts immediately after the first failure, then backs off with a cap", () => {
    expect(restartDelay(1)).toBe(0)
    expect(restartDelay(2)).toBe(2_000)
    expect(restartDelay(3)).toBe(4_000)
    expect(restartDelay(20)).toBe(5 * 60_000)
  })
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({})],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

describe("LSP service resilience", () => {
  it.instance(
    "drops a crashed server and respawns it on next use",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const file = path.join(dir, "sample.repro")
        yield* Effect.promise(() => Bun.write(file, "sample\n"))

        yield* lsp.touchFile(file)
        expect((yield* lsp.status()).length).toBe(1)

        // The fake server exits when asked for hover at this line.
        yield* lsp.hover({ file, line: 4242, character: 0 })
        for (let i = 0; i < 100 && (yield* lsp.status()).length > 0; i++) yield* Effect.sleep("20 millis")
        expect((yield* lsp.status()).length).toBe(0)

        yield* lsp.touchFile(file)
        expect((yield* lsp.status()).length).toBe(1)
        expect(yield* lsp.hover({ file, line: 0, character: 0 })).toEqual([null])
      }),
    {
      config: {
        lsp: {
          fake: {
            command: [process.execPath, fakeServerPath],
            extensions: [".repro"],
          },
        },
      },
    },
  )
})
