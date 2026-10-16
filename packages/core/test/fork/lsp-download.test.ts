import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import { LSP } from "@opencode/core/fork/lsp/lsp"
import { LSPServer } from "@opencode/core/fork/lsp/server"
import { builtIns } from "@opencode/core/fork/lsp/servers/index"
import { Biome, Typescript } from "@opencode/core/fork/lsp/servers/web"
import { lspDocument, lspLayer, type Harness } from "../fixture/lsp/service"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// Every case builds its own layer, so it owns a fresh project directory and its own recorded calls.
const test = <A, E>(
  name: string,
  options: Parameters<typeof lspLayer>[0],
  body: (lsp: LSP.Interface, harness: Harness) => Effect.Effect<A, E>,
) => {
  const { layer, harness } = lspLayer(options)
  testEffect(layer).live(name, () => LSP.Service.use((lsp) => body(lsp, harness)))
}

const write = (file: string, text = "stub\n") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

/** The npm and source trees a server needs to get past its local checks and reach an install. */
const typescriptStub = (directory: string) =>
  Effect.all([
    write(path.join(directory, "src", "a.ts")),
    write(
      path.join(directory, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "0.0.0" }),
    ),
    write(path.join(directory, "node_modules", "typescript", "lib", "tsserver.js"), "// stub\n"),
  ])

const biomeStub = (directory: string) =>
  Effect.all([
    write(path.join(directory, "src", "a.ts")),
    write(
      path.join(directory, "node_modules", "@biomejs", "biome", "package.json"),
      JSON.stringify({ name: "@biomejs/biome", version: "0.0.0", main: "index.js" }),
    ),
    write(path.join(directory, "node_modules", "@biomejs", "biome", "index.js"), "// stub\n"),
  ])

describe("downloads disabled", () => {
  it.effect("makeContext keeps every install member inert, keeping the opt-out true for every server", () =>
    Effect.gen(function* () {
      const explode = () => Effect.die(new Error("the install capability must not be reachable"))
      const context = LSPServer.makeContext({
        directory: "/nowhere",
        worktree: "/nowhere",
        bin: "/nowhere/bin",
        home: "/nowhere",
        env: {},
        flags: { disableDownload: true, experimentalTy: false },
        fs: {} as never,
        npm: { which: explode } as never,
        processes: { run: explode } as never,
        http: HttpClient.make(() => explode()) as never,
      })
      expect(context.install.enabled).toBe(false)
      expect(yield* context.install.npm("typescript-language-server")).toBeUndefined()
      expect(yield* context.install.npm("biome")).toBeUndefined()
      expect(yield* context.install.json("https://api.github.com/repos/clangd/clangd/releases/latest")).toBeUndefined()
      expect(yield* context.install.download("https://example.com/tool.zip", "/nowhere/tool.zip")).toBe(false)
      expect(yield* context.install.extract("/nowhere/tool.zip", "/nowhere")).toBe(false)
      expect(yield* context.install.run("sh", ["-c", "touch /nowhere/pwned"])).toBe(false)
    }),
  )

  test(
    "typescript never reaches npm while downloads are disabled, and does when they are enabled",
    { entries: [lspDocument(true)], builtIns: [Typescript], flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* typescriptStub(h.directory)
        const file = path.join(h.directory, "src", "a.ts")
        expect(yield* lsp.hasClients(file)).toBe(true)
        yield* lsp.touchFile(file)
        // The only sources left for the server binary are PATH and the guarded install, which stays inert.
        expect(h.npm).toEqual([])
        expect(h.processes).toEqual([])
        expect(h.http).toEqual([])
      }),
  )

  test(
    "typescript asks npm when downloads are enabled",
    { entries: [lspDocument(true)], builtIns: [Typescript], flags: { disableDownload: false } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* typescriptStub(h.directory)
        yield* lsp.touchFile(path.join(h.directory, "src", "a.ts"))
        expect(h.npm).toContain("typescript-language-server")
      }),
  )

  test(
    "biome never reaches npm while downloads are disabled, and does when they are enabled",
    { entries: [lspDocument(true)], builtIns: [Biome], flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* biomeStub(h.directory)
        const file = path.join(h.directory, "src", "a.ts")
        expect(yield* lsp.hasClients(file)).toBe(true)
        yield* lsp.touchFile(file)
        expect(h.npm).toEqual([])
        expect(h.processes).toEqual([])
        expect(h.http).toEqual([])
      }),
  )

  test(
    "biome asks npm when downloads are enabled",
    { entries: [lspDocument(true)], builtIns: [Biome], flags: { disableDownload: false } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* biomeStub(h.directory)
        yield* lsp.touchFile(path.join(h.directory, "src", "a.ts"))
        expect(h.npm).toContain("@biomejs/biome")
      }),
  )

  test(
    "no built-in server reaches npm, the network, or an installer while downloads are disabled",
    { entries: [lspDocument(true)], builtIns, flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        for (const server of builtIns) {
          const extension = server.extensions.find((candidate) => candidate.startsWith("."))
          if (!extension) continue
          const file = path.join(h.directory, "probe" + extension)
          yield* write(file)
          yield* lsp.touchFile(file)
        }
        expect(h.npm).toEqual([])
        expect(h.http).toEqual([])
        expect(h.processes.filter((command) => /install|(^| )npm |pip |cargo |dotnet tool|go get|curl |wget /i.test(command))).toEqual([])
      }),
  )
})
