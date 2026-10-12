import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LSP } from "@opencode/core/fork/lsp/lsp"
import { LSPServer } from "@opencode/core/fork/lsp/server"
import { Config } from "@opencode/core/config"
import { fakeEntry, finding } from "../fixture/lsp/lsp"
import { lspDocument, lspLayer, type Harness } from "../fixture/lsp/service"
import { testEffect } from "../lib/effect"

const write = (file: string, text = "sample\n") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

/** A built-in stand-in that counts how often it is asked to start and never produces a process. */
const spy = (id: string, extensions: string[], root: LSPServer.Info["root"] = (_file, ctx) => Effect.succeed(ctx.directory)) => {
  const calls: { root: string; ctx: LSPServer.Context }[] = []
  const server: LSPServer.Info = {
    id,
    extensions,
    root,
    spawn: (root, ctx) => Effect.sync(() => void calls.push({ root, ctx })).pipe(Effect.as(undefined)),
  }
  return { server, calls }
}

// Each case builds its own layer, so it owns a fresh project directory and its own recorded calls.
const test = <A, E>(
  name: string,
  options: Parameters<typeof lspLayer>[0],
  body: (lsp: LSP.Interface, harness: Harness) => Effect.Effect<A, E, Config.Test>,
) => {
  const { layer, harness } = lspLayer(options)
  testEffect(layer).live(name, () => LSP.Service.use((lsp) => body(lsp, harness)))
}

describe("LSP service spawning", () => {
  const outside = spy("typescript", [".ts"])
  test("does not start a built-in for files outside the project", { entries: [lspDocument(true)], builtIns: [outside.server] }, (lsp, h) =>
    Effect.gen(function* () {
      yield* lsp.touchFile(path.join(h.directory, "..", "outside.ts"))
      yield* lsp.hover({ file: path.join(h.directory, "..", "hover.ts"), line: 0, character: 0 })
      expect(yield* lsp.hasClients(path.join(h.directory, "..", "outside.ts"))).toBe(false)
      expect(outside.calls).toHaveLength(0)
    }),
  )

  const unset = spy("typescript", [".ts"])
  test("starts nothing when lsp is unset", { builtIns: [unset.server] }, (lsp, h) =>
    Effect.gen(function* () {
      expect(yield* lsp.hasClients(path.join(h.directory, "src", "inside.ts"))).toBe(false)
      yield* lsp.hover({ file: path.join(h.directory, "src", "inside.ts"), line: 0, character: 0 })
      expect(unset.calls).toHaveLength(0)
    }),
  )

  const disabled = spy("typescript", [".ts"])
  test("starts nothing when lsp is false", { entries: [lspDocument(false)], builtIns: [disabled.server] }, (lsp, h) =>
    Effect.gen(function* () {
      yield* lsp.hover({ file: path.join(h.directory, "src", "inside.ts"), line: 0, character: 0 })
      expect(disabled.calls).toHaveLength(0)
    }),
  )

  const enabled = spy("typescript", [".ts"])
  test("starts a built-in for files inside the project when lsp is true", { entries: [lspDocument(true)], builtIns: [enabled.server] }, (lsp, h) =>
    Effect.gen(function* () {
      expect(yield* lsp.hasClients(path.join(h.directory, "test.ts"))).toBe(true)
      yield* lsp.hover({ file: path.join(h.directory, "src", "inside.ts"), line: 0, character: 0 })
      expect(enabled.calls).toHaveLength(1)
    }),
  )

  const objectConfig = spy("typescript", [".ts"])
  const eslint = spy("eslint", [".ts"])
  test(
    "keeps the built-ins when the config is an object that only disables one",
    { entries: [lspDocument({ eslint: { disabled: true } })], builtIns: [objectConfig.server, eslint.server] },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* lsp.hover({ file: path.join(h.directory, "src", "inside.ts"), line: 0, character: 0 })
        expect(objectConfig.calls).toHaveLength(1)
        expect(eslint.calls).toHaveLength(0)
      }),
  )

  const ty = spy("ty", [".py"])
  const pyright = spy("pyright", [".py"])
  test("uses pyright instead of ty by default", { entries: [lspDocument(true)], builtIns: [ty.server, pyright.server] }, (lsp, h) =>
    Effect.gen(function* () {
      yield* lsp.hover({ file: path.join(h.directory, "src", "inside.py"), line: 0, character: 0 })
      expect(ty.calls).toHaveLength(0)
      expect(pyright.calls).toHaveLength(1)
    }),
  )

  const tyOn = spy("ty", [".py"])
  const pyrightOff = spy("pyright", [".py"])
  test(
    "uses ty instead of pyright when the experimental flag is set",
    { entries: [lspDocument(true)], flags: { experimentalTy: true }, builtIns: [tyOn.server, pyrightOff.server] },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* lsp.hover({ file: path.join(h.directory, "src", "inside.py"), line: 0, character: 0 })
        expect(tyOn.calls).toHaveLength(1)
        expect(pyrightOff.calls).toHaveLength(0)
      }),
  )

  const flagged = spy("pyright", [".py"])
  test(
    "hands every server the download opt-out through its context",
    { entries: [lspDocument(true)], flags: { disableDownload: true }, builtIns: [flagged.server] },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* lsp.hover({ file: path.join(h.directory, "src", "inside.py"), line: 0, character: 0 })
        expect(flagged.calls[0]?.ctx.flags.disableDownload).toBe(true)
        expect(flagged.calls[0]?.ctx.install.enabled).toBe(false)
      }),
  )

  const broken = spy("typescript", [".ts"])
  test("a server that is not installed is not asked again", { entries: [lspDocument(true)], builtIns: [broken.server] }, (lsp, h) =>
    Effect.gen(function* () {
      const file = path.join(h.directory, "a.ts")
      yield* lsp.touchFile(file)
      yield* lsp.touchFile(file)
      yield* lsp.hover({ file, line: 0, character: 0 })
      expect(broken.calls).toHaveLength(1)
      expect(yield* lsp.hasClients(file)).toBe(false)
    }),
  )
})

describe("LSP service configuration", () => {
  test(
    "publishes lsp.updated after a configured server initializes",
    { entries: [lspDocument({ fake: fakeEntry([".repro"]) })] },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* write(path.join(h.directory, "sample.repro"))
        yield* lsp.touchFile(path.join(h.directory, "sample.repro"))
        expect(h.events).toContain("lsp.updated")
        expect((yield* lsp.status()).map((item) => item.id)).toEqual(["fake"])
      }),
  )

  const pyright = spy("pyright", [".py", ".pyi"], LSPServer.nearestRoot(["pyproject.toml"]))
  test(
    "a configured entry overrides a built-in by id and keeps its root detection",
    {
      entries: [lspDocument({ pyright: { command: [process.execPath, path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.cjs")] } })],
      builtIns: [pyright.server],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        const project = path.join(h.directory, "pkg")
        yield* write(path.join(project, "pyproject.toml"), "")
        yield* write(path.join(project, "src", "a.py"))
        yield* lsp.touchFile(path.join(project, "src", "a.py"))
        expect(yield* lsp.status()).toEqual([{ id: "pyright", name: "pyright", root: "pkg", status: "connected" }])
        // The built-in's own resolver was replaced by the configured command.
        expect(pyright.calls).toHaveLength(0)
      }),
  )

  test(
    "a configured entry keeps the extensions of the built-in it replaces unless it sets its own",
    {
      entries: [lspDocument({ pyright: { command: [process.execPath, path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.cjs")] } })],
      builtIns: [spy("pyright", [".py"]).server],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        expect(yield* lsp.hasClients(path.join(h.directory, "a.py"))).toBe(true)
        expect(yield* lsp.hasClients(path.join(h.directory, "a.ts"))).toBe(false)
      }),
  )

  test(
    "a custom server roots at the project directory",
    { entries: [lspDocument({ fake: fakeEntry([".repro"]) })] },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* write(path.join(h.directory, "deep", "er", "sample.repro"))
        yield* lsp.touchFile(path.join(h.directory, "deep", "er", "sample.repro"))
        expect((yield* lsp.status())[0]?.root).toBe("")
      }),
  )

  test(
    "a later document merges over an earlier one by server id",
    {
      entries: [
        lspDocument({ fake: fakeEntry([".repro"]), other: fakeEntry([".other"]) }),
        lspDocument({ fake: { disabled: true } }),
      ],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        expect(yield* lsp.hasClients(path.join(h.directory, "a.repro"))).toBe(false)
        expect(yield* lsp.hasClients(path.join(h.directory, "a.other"))).toBe(true)
      }),
  )

  test(
    "a configuration reload stops running servers and applies the new entries",
    { entries: [lspDocument({ fake: fakeEntry([".repro"]) })] },
    (lsp, h) =>
      Effect.gen(function* () {
        const file = path.join(h.directory, "sample.repro")
        yield* write(file)
        yield* lsp.touchFile(file)
        expect(yield* lsp.status()).toHaveLength(1)
        const config = yield* Config.Test
        yield* config.setEntries([lspDocument({ fake: { disabled: true } })])
        expect(yield* lsp.hasClients(file)).toBe(false)
        expect(yield* lsp.status()).toHaveLength(0)
      }),
  )
})

describe("LSP service diagnostics", () => {
  const server = (source: string, findings: ReturnType<typeof finding>[]) =>
    fakeEntry([".repro"], { FAKE_LSP_PUBLISH: JSON.stringify(findings), FAKE_LSP_SOURCE: source })

  const merged = (lsp: LSP.Interface, directory: string) =>
    Effect.gen(function* () {
      const file = path.join(directory, "sample.repro")
      yield* write(file)
      yield* lsp.touchFile(file, "document")
      return (yield* lsp.diagnostics())[file] ?? []
    })

  // Servers tag findings with their own `source`, so the same finding from two servers is never equal as a whole.
  test(
    "reports a finding once when two servers claim the same file",
    {
      entries: [
        lspDocument({
          first: server("one", [finding(0, "alpha"), finding(1, "beta")]),
          second: server("two", [finding(1, "beta"), finding(2, "gamma")]),
        }),
      ],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        expect((yield* merged(lsp, h.directory)).map((item) => item.message)).toEqual(["alpha", "beta", "gamma"])
      }),
  )

  test(
    "keeps findings that differ in position or severity",
    {
      entries: [
        lspDocument({
          first: server("one", [finding(0, "same"), finding(1, "same")]),
          second: server("two", [finding(0, "same", 2)]),
        }),
      ],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        const found = yield* merged(lsp, h.directory)
        expect(found.map((item) => `${item.range.start.line}:${item.severity}`)).toEqual(["0:1", "1:1", "0:2"])
      }),
  )

  test(
    "passes a single server's list through unchanged",
    { entries: [lspDocument({ only: server("one", [finding(0, "alpha"), finding(1, "beta")]) })] },
    (lsp, h) =>
      Effect.gen(function* () {
        expect((yield* merged(lsp, h.directory)).map((item) => item.message)).toEqual(["alpha", "beta"])
      }),
  )

  test(
    "reports nothing before any file was opened",
    { entries: [lspDocument({ only: server("one", [finding(0, "alpha")]) })] },
    (lsp) =>
      Effect.gen(function* () {
        expect(yield* lsp.diagnostics()).toEqual({})
        expect(yield* lsp.status()).toEqual([])
      }),
  )
})

describe("LSP service queries", () => {
  const results = {
    "textDocument/definition": [{ uri: "file:///a.repro", range: finding(0, "").range }],
    "textDocument/references": [{ uri: "file:///a.repro" }, { uri: "file:///b.repro" }],
    "textDocument/hover": { contents: "docs" },
    "textDocument/documentSymbol": [{ name: "main", kind: 12 }],
    "workspace/symbol": [
      { name: "keep", kind: 12 },
      { name: "drop", kind: 8 },
      ...Array.from({ length: 20 }, (_, index) => ({ name: `f${index}`, kind: 5 })),
    ],
    "callHierarchy/incomingCalls": [{ from: { name: "caller" } }],
    "textDocument/prepareCallHierarchy": [{ name: "main" }],
  }
  const entry = { entries: [lspDocument({ fake: fakeEntry([".repro"], { FAKE_LSP_RESULTS: JSON.stringify(results) }) })] }

  test("flattens definition, references, and symbols across servers", entry, (lsp, h) =>
    Effect.gen(function* () {
      const file = path.join(h.directory, "a.repro")
      yield* write(file)
      const at = { file, line: 0, character: 0 }
      expect(yield* lsp.definition(at)).toHaveLength(1)
      expect(yield* lsp.references(at)).toHaveLength(2)
      expect(yield* lsp.hover(at)).toEqual([{ contents: "docs" }])
      expect(yield* lsp.documentSymbol(file)).toEqual([{ name: "main", kind: 12 }])
    }),
  )

  test("answers a call hierarchy through prepare then the direction request", entry, (lsp, h) =>
    Effect.gen(function* () {
      const file = path.join(h.directory, "a.repro")
      yield* write(file)
      expect(yield* lsp.prepareCallHierarchy({ file, line: 0, character: 0 })).toEqual([{ name: "main" }])
      expect(yield* lsp.incomingCalls({ file, line: 0, character: 0 })).toEqual([{ from: { name: "caller" } }])
      // The fake has no canned outgoing result, which a server reports as null.
      expect(yield* lsp.outgoingCalls({ file, line: 0, character: 0 })).toEqual([])
    }),
  )

  test("workspace symbols come only from running servers, filtered by kind and capped per server", entry, (lsp, h) =>
    Effect.gen(function* () {
      expect(yield* lsp.workspaceSymbol("")).toEqual([])
      const file = path.join(h.directory, "a.repro")
      yield* write(file)
      yield* lsp.touchFile(file)
      const symbols = (yield* lsp.workspaceSymbol("x")) as { name: string }[]
      expect(symbols).toHaveLength(10)
      expect(symbols[0]?.name).toBe("keep")
      expect(symbols.map((item) => item.name)).not.toContain("drop")
    }),
  )

  test("a query with no matching server returns nothing instead of failing", entry, (lsp, h) =>
    Effect.gen(function* () {
      const file = path.join(h.directory, "a.other")
      expect(yield* lsp.hover({ file, line: 0, character: 0 })).toEqual([])
      expect(yield* lsp.definition({ file, line: 0, character: 0 })).toEqual([])
      expect(yield* lsp.documentSymbol(file)).toEqual([])
    }),
  )
})

describe("LSP service resilience", () => {
  test(
    "drops a crashed server and respawns it on next use",
    { entries: [lspDocument({ fake: fakeEntry([".repro"]) })] },
    (lsp, h) =>
      Effect.gen(function* () {
        const file = path.join(h.directory, "sample.repro")
        yield* write(file)
        yield* lsp.touchFile(file)
        expect(yield* lsp.status()).toHaveLength(1)

        // The fake server exits when asked for hover at this line.
        yield* lsp.hover({ file, line: 4242, character: 0 })
        yield* Effect.promise(async () => {
          for (let i = 0; i < 100; i++) {
            if ((await Effect.runPromise(lsp.status())).length === 0) return
            await Bun.sleep(20)
          }
        })
        expect(yield* lsp.status()).toHaveLength(0)
        expect(h.events.filter((type) => type === "lsp.updated").length).toBeGreaterThanOrEqual(2)

        yield* lsp.touchFile(file)
        expect(yield* lsp.status()).toHaveLength(1)
        expect(yield* lsp.hover({ file, line: 0, character: 0 })).toEqual([])
      }),
  )

  test("restarts immediately after the first failure, then backs off with a cap", {}, () =>
    Effect.sync(() => {
      expect(LSP.restartDelay(1)).toBe(0)
      expect(LSP.restartDelay(2)).toBe(2_000)
      expect(LSP.restartDelay(3)).toBe(4_000)
      expect(LSP.restartDelay(20)).toBe(5 * 60_000)
    }),
  )

  const failing = {
    id: "typescript",
    extensions: [".ts"],
    root: (_file: string, ctx: LSPServer.Context) => Effect.succeed(ctx.directory),
    attempts: 0,
  }
  test(
    "a server that fails to initialize is retried once, then backs off instead of respawning in a loop",
    {
      entries: [lspDocument(true)],
      builtIns: [
        {
          id: failing.id,
          extensions: failing.extensions,
          root: failing.root,
          spawn: (root: string) =>
            Effect.sync(() => {
              failing.attempts++
              return LSPServer.launch(root, path.join(root, "no-such-language-server"))
            }),
        },
      ],
    },
    (lsp, h) =>
      Effect.gen(function* () {
        const file = path.join(h.directory, "a.ts")
        yield* write(file)
        yield* lsp.touchFile(file)
        yield* lsp.touchFile(file)
        yield* lsp.touchFile(file)
        yield* lsp.touchFile(file)
        // The first failure restarts at once; the second one starts a 2 s cooldown during which nothing is spawned.
        expect(failing.attempts).toBe(2)
        expect(yield* lsp.status()).toEqual([])
      }),
  )
})

describe("LSP server context", () => {
  test("the optional extensions list falls back to attaching to every file", {}, () =>
    Effect.sync(() => {
      expect(LSPServer.flagsFromEnv({ OPENCODE_DISABLE_LSP_DOWNLOAD: "1" }).disableDownload).toBe(true)
      expect(LSPServer.flagsFromEnv({ OPENCODE_DISABLE_LSP_DOWNLOAD: "true" }).disableDownload).toBe(true)
      expect(LSPServer.flagsFromEnv({ OPENCODE_DISABLE_LSP_DOWNLOAD: "0" }).disableDownload).toBe(false)
      expect(LSPServer.flagsFromEnv({}).disableDownload).toBe(false)
      expect(LSPServer.flagsFromEnv({ OPENCODE_EXPERIMENTAL_LSP_TY: "1" }).experimentalTy).toBe(true)
    }),
  )
})
