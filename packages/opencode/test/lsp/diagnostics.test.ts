import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { LSP } from "@/lsp/lsp"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({})],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

const finding = (line: number, message: string, severity = 1) => ({
  range: { start: { line, character: 0 }, end: { line, character: 4 } },
  severity,
  message,
})

// Servers tag findings with their own `source`, so the same finding from two servers is never equal as a whole.
const server = (source: string, findings: ReturnType<typeof finding>[]) => ({
  command: [process.execPath, fakeServerPath],
  extensions: [".repro"],
  env: { FAKE_LSP_PUBLISH: JSON.stringify(findings.map((item) => ({ ...item, source }))) },
})

const merged = (file: string) =>
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    yield* Effect.promise(() => Bun.write(file, "sample\n"))
    yield* lsp.touchFile(file, "document")
    return (yield* lsp.diagnostics())[FSUtil.normalizePath(file)] ?? []
  })

describe("LSP.diagnostics merge", () => {
  it.instance(
    "reports a finding once when two servers claim the same file",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const found = yield* merged(path.join(dir, "sample.repro"))
        expect(found.map((item) => item.message)).toEqual(["alpha", "beta", "gamma"])
      }),
    {
      config: {
        lsp: {
          first: server("one", [finding(0, "alpha"), finding(1, "beta")]),
          second: server("two", [finding(1, "beta"), finding(2, "gamma")]),
        },
      },
    },
  )

  it.instance(
    "keeps findings that differ in position or severity",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const found = yield* merged(path.join(dir, "sample.repro"))
        expect(found.map((item) => `${item.range.start.line}:${item.severity}`)).toEqual(["0:1", "1:1", "0:2"])
      }),
    {
      config: {
        lsp: {
          first: server("one", [finding(0, "same"), finding(1, "same")]),
          second: server("two", [finding(0, "same", 2)]),
        },
      },
    },
  )

  it.instance(
    "passes a single server's list through unchanged",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const found = yield* merged(path.join(dir, "sample.repro"))
        expect(found.map((item) => item.message)).toEqual(["alpha", "beta"])
      }),
    { config: { lsp: { only: server("one", [finding(0, "alpha"), finding(1, "beta")]) } } },
  )
})
