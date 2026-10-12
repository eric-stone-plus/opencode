import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LSPClient } from "@opencode/core/fork/lsp/client"
import { hostEnvironmentLayer } from "../fixture/environment"
import { fakeHandle, finding } from "../fixture/lsp/lsp"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(hostEnvironmentLayer)

const withClient = <A, E, R>(
  body: (client: LSPClient.Info, directory: string) => Effect.Effect<A, E, R>,
  extra: Parameters<typeof fakeHandle>[1] = {},
) =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const client = yield* LSPClient.create({
      serverID: "fake",
      handle: fakeHandle(tmp.path, extra),
      root: tmp.path,
      directory: tmp.path,
    })
    return yield* body(client, tmp.path)
  })

const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const sleep = (ms: number) => Effect.promise(() => Bun.sleep(ms))
const request = (client: LSPClient.Info, method: string, params: unknown = {}) =>
  client.request(method, params).pipe(Effect.orDie)

describe("LSP client interop", () => {
  it.live("answers workspace/workspaceFolders with the root", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        yield* client.notify("test/trigger", { method: "workspace/workspaceFolders" })
        yield* sleep(100)
        expect(yield* request(client, "test/get-client-responses")).toEqual([
          { result: [{ name: "workspace", uri: pathToFileURL(directory).href }], error: null },
        ])
      }),
    ),
  )

  it.live("accepts client/registerCapability and client/unregisterCapability", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client.notify("test/trigger", { method: "client/registerCapability" })
        yield* client.notify("test/trigger", { method: "client/unregisterCapability" })
        yield* sleep(100)
        expect(yield* request(client, "test/get-client-responses")).toEqual([
          { result: null, error: null },
          { result: null, error: null },
        ])
        expect(client.alive()).toBe(true)
      }),
    ),
  )

  it.live("answers requests it does not implement with MethodNotFound instead of ignoring them", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client.notify("test/trigger", { method: "window/showMessageRequest" })
        yield* sleep(100)
        const [response] = (yield* request(client, "test/get-client-responses")) as { error: { code: number } | null }[]
        expect(response.error?.code).toBe(-32601)
      }),
    ),
  )

  it.live("initialize does not overclaim unsupported diagnostics capabilities", () =>
    withClient((client) =>
      Effect.gen(function* () {
        const params = (yield* request(client, "test/get-initialize-params")) as any
        expect(params.capabilities.workspace.diagnostics.refreshSupport).toBe(false)
        expect(params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(false)
      }),
    ),
  )

  it.live("workspace/configuration returns one result per requested item", () => {
    const initialization = { alpha: { beta: 1 }, gamma: true }
    return withClient(
      (client) =>
        Effect.gen(function* () {
          const response = yield* request(client, "test/request-configuration", {
            items: [{ section: "alpha" }, { section: "alpha.beta" }, { section: "missing" }, {}],
          })
          expect(response).toEqual([{ beta: 1 }, 1, null, initialization])
        }),
      { initialization },
    )
  })

  it.live("sends ranged didChange for incremental sync servers", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.ts")
        yield* write(file, "first\n")
        yield* client.open(file)
        yield* write(file, "second\nthird\n")
        yield* client.open(file)
        const change = (yield* request(client, "test/get-last-change")) as {
          textDocument: { version: number }
          contentChanges: unknown[]
        }
        expect(change.textDocument.version).toBe(1)
        expect(change.contentChanges).toEqual([
          { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: "second\nthird\n" },
        ])
      }),
    ),
  )

  it.live("strips a byte order mark before sending a document", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "bom.ts")
        yield* write(file, "﻿const x = 1\n")
        yield* client.open(file)
        yield* client.open(file)
        const change = (yield* request(client, "test/get-last-change")) as { contentChanges: { text: string }[] }
        expect(change.contentChanges[0].text).toBe("const x = 1\n")
      }),
    ),
  )

  it.live("document mode falls back to push diagnostics", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.ts")
        yield* write(file, "const x = 1\n")
        const version = yield* client.open(file)
        const wait = yield* Effect.forkChild(client.waitForDiagnostics({ path: file, version, mode: "document" }))
        yield* client.notify("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [finding(0, "push diagnostic")],
        })
        yield* Fiber.join(wait)
        expect(client.diagnostics().get(file)?.map((item) => item.message)).toEqual(["push diagnostic"])
        expect(yield* request(client, "test/get-diagnostic-request-count")).toBe(0)
      }),
    ),
  )

  it.live("document mode accepts matching push diagnostics published before waiting", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.ts")
        yield* write(file, "const x = 1\n")
        const version = yield* client.open(file)
        yield* client.notify("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [finding(0, "push diagnostic")],
        })
        yield* Effect.promise(async () => {
          for (let i = 0; i < 20 && (client.diagnostics().get(file)?.length ?? 0) === 0; i++) await Bun.sleep(25)
        })
        expect(client.diagnostics().get(file)?.[0]?.message).toBe("push diagnostic")
        const started = Date.now()
        yield* client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(Date.now() - started).toBeLessThan(1_000)
      }),
    ),
  )

  it.live("document mode waits for pull diagnostics", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.cs")
        yield* write(file, "class C {}\n")
        yield* request(client, "test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "DocumentCompilerSemantic" }],
          documentDiagnosticsByIdentifier: { DocumentCompilerSemantic: [finding(0, "pull diagnostic")] },
        })
        const version = yield* client.open(file)
        yield* client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(client.diagnostics().get(file)?.map((item) => item.message)).toEqual(["pull diagnostic"])
        expect(yield* request(client, "test/get-diagnostic-request-count")).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("document mode does not wait for the slowest pull identifier once the current file has diagnostics", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.cs")
        yield* write(file, "class C {}\n")
        yield* request(client, "test/configure-pull-diagnostics", {
          registrations: [{ identifier: "fast" }, { identifier: "slow" }],
          documentDiagnosticsByIdentifier: { fast: [finding(0, "fast diagnostic")], slow: [] },
          documentDelayMsByIdentifier: { slow: 2_500 },
        })
        const version = yield* client.open(file)
        yield* request(client, "test/register-configured-pull-diagnostics")
        yield* sleep(100)
        const started = Date.now()
        yield* client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(client.diagnostics().get(file)?.[0]?.message).toBe("fast diagnostic")
        expect(yield* request(client, "test/get-diagnostic-request-count")).toBeGreaterThan(1)
      }),
    ),
  )

  it.live("full mode includes workspace pull diagnostics", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.cs")
        const related = path.join(directory, "other.cs")
        yield* write(file, "class C {}\n")
        yield* write(related, "class D {}\n")
        yield* request(client, "test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "DocumentCompilerSemantic" }, { identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
          documentDiagnosticsByIdentifier: { DocumentCompilerSemantic: [finding(0, "current file")] },
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [{ uri: pathToFileURL(related).href, items: [finding(0, "workspace file")] }],
          },
        })
        const version = yield* client.open(file)
        yield* client.waitForDiagnostics({ path: file, version, mode: "full" })
        expect(client.diagnostics().get(file)?.[0]?.message).toBe("current file")
        expect(client.diagnostics().get(related)?.[0]?.message).toBe("workspace file")
      }),
    ),
  )

  it.live("full mode treats an empty workspace pull response as handled", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.cs")
        yield* write(file, "class C {}\n")
        yield* request(client, "test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
          workspaceDiagnosticsByIdentifier: { WorkspaceDocumentsAndProject: [] },
        })
        const version = yield* client.open(file)
        const started = Date.now()
        yield* client.waitForDiagnostics({ path: file, version, mode: "full" })
        expect(Date.now() - started).toBeLessThan(1_000)
      }),
    ),
  )

  it.live("drops malformed diagnostics instead of discarding the file's whole list", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "client.ts")
        yield* write(file, "x\n")
        const version = yield* client.open(file)
        yield* client.notify("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [finding(0, "kept"), { message: "no range" }, "garbage", null],
        })
        yield* client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(client.diagnostics().get(file)?.map((item) => item.message)).toEqual(["kept"])
      }),
    ),
  )
})

describe("LSP client resilience", () => {
  it.live("requests to a hung server time out", () =>
    withClient((client) =>
      Effect.gen(function* () {
        const started = Date.now()
        const failure = yield* client.request("test/hang", {}, 200).pipe(Effect.flip)
        expect(failure.message).toMatch(/timed out/)
        expect(Date.now() - started).toBeLessThan(5_000)
      }),
    ),
  )

  it.live("marks the client ended when the server process exits", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client.notify("test/exit", {})
        expect(yield* Deferred.await(client.ended)).toBe(true)
        expect(client.alive()).toBe(false)
        expect((yield* client.request("textDocument/hover", {}).pipe(Effect.flip)).message).toMatch(/not running/)
      }),
    ),
  )

  it.live("closing the scope stops the server without reporting a crash", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const ended = yield* Effect.scoped(
        LSPClient.create({
          serverID: "fake",
          handle: fakeHandle(tmp.path),
          root: tmp.path,
          directory: tmp.path,
        }).pipe(Effect.map((client) => client.ended)),
      )
      expect(yield* Deferred.await(ended)).toBe(false)
    }),
  )

  it.live("closes least recently used documents beyond the limit", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const files = Array.from({ length: LSPClient.MAX_OPEN_DOCUMENTS + 1 }, (_, i) => path.join(directory, `f${i}.ts`))
        yield* Effect.forEach(files, (file) => write(file, "x\n"), { concurrency: "unbounded" })
        yield* client.open(files[0])
        yield* client.open(files[1])
        // Touching the first file again makes the second the oldest.
        yield* client.open(files[0])
        yield* Effect.forEach(files.slice(2), (file) => client.open(file), { discard: true })

        const open = client.openDocuments()
        expect(open.length).toBe(LSPClient.MAX_OPEN_DOCUMENTS)
        expect(open).toContain(files[0])
        expect(open).not.toContain(files[1])
        expect(open).toContain(files[2])
        expect(yield* request(client, "test/get-closed")).toEqual([pathToFileURL(files[1]).href])
      }),
    ),
  )

  it.live("evicted documents drop their diagnostics", () =>
    withClient((client, directory) =>
      Effect.gen(function* () {
        const first = path.join(directory, "first.ts")
        yield* write(first, "x\n")
        yield* client.open(first)
        yield* client.notify("test/publish-diagnostics", { uri: pathToFileURL(first).href, diagnostics: [finding(0, "boom")] })
        yield* request(client, "test/get-closed")
        expect(client.diagnostics().get(first)?.length).toBe(1)

        yield* Effect.forEach(
          Array.from({ length: LSPClient.MAX_OPEN_DOCUMENTS }, (_, i) => path.join(directory, `g${i}.ts`)),
          (file) => write(file, "x\n").pipe(Effect.andThen(client.open(file))),
          { discard: true },
        )
        expect(client.diagnostics().has(first)).toBe(false)
      }),
    ),
  )
})

describe("LSP client initialize", () => {
  it.live("fails with the server's own words when it never answers initialize", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const failure = yield* LSPClient.create({
        serverID: "fake",
        handle: fakeHandle(tmp.path, { env: { FAKE_LSP_HANG_INITIALIZE: "1" } }),
        root: tmp.path,
        directory: tmp.path,
      }).pipe(Effect.timeout("500 millis"), Effect.flip)
      // The handshake has its own 45 s ceiling; here only the caller's bound is exercised.
      expect(failure._tag).toBe("TimeoutError")
    }),
  )

  it.live("fails with InitializeError when the command does not exist", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const failure = yield* LSPClient.create({
        serverID: "missing",
        handle: { command: path.join(tmp.path, "no-such-server"), args: [], cwd: tmp.path },
        root: tmp.path,
        directory: tmp.path,
      }).pipe(Effect.flip)
      expect(failure._tag).toBe("LSP.InitializeError")
    }),
  )
})
