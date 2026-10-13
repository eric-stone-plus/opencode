import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { LSPPlugin } from "@opencode/core/plugin/fork/lsp"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { hostEnvironmentLayer } from "../../fixture/environment"
import { tempGlobalLayer } from "../../fixture/global"
import { fakeEntry } from "../../fixture/lsp/lsp"
import { lspDocument } from "../../fixture/lsp/service"
import { tmpdirScoped } from "../../fixture/tmpdir"
import { testEffect } from "../../lib/effect"
import { permissionLayer } from "../../lib/permission"
import { executeTool, toolIdentity } from "../../lib/tool"
import { makePluginTestLayer } from "../../plugin/fixture"

// The plugin builds its own LSP service, so the layer needs the LSP dependencies plus the services
// the plugin context exposes. Global and Environment are not part of the plugin test layer, because
// only LSP-backed plugins need them.
const layer = Layer.mergeAll(
  makePluginTestLayer(permissionLayer({ assert: () => Effect.void })),
  tempGlobalLayer,
  hostEnvironmentLayer,
)
const it = testEffect(layer)

const sessionID = SessionSchema.ID.make("ses_lsp_plugin")

const write = (directory: string, file: string, text = "sample\n") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })

/** Registers the plugin against a fake server configured for `extensions` and returns the tool runner. */
const prepare = (input: { lsp: unknown; plugin?: Parameters<typeof LSPPlugin.make>[0] }) =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const pluginHost = yield* PluginHost.make(plugins)
    const config = yield* Config.Test
    yield* config.setEntries([lspDocument(input.lsp)])
    yield* LSPPlugin.make({ builtIns: [], env: { PATH: "" }, ...input.plugin }).effect(pluginHost)
    const registry = yield* Tool.Service
    const location = yield* Location.Service
    const directory = location.directory
    const hooks = yield* PluginHooks.Service
    const run = (name: string, toolInput: unknown, id = "call-1") =>
      executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id, name, input: toolInput },
      })
    const fire = (event: AfterEvent) => hooks.trigger("tool", "execute.after", event)
    return { directory, run, fire }
  })

type AfterEvent = PluginHooks.Domains["tool"]["execute.after"]
type CompletedEvent = Extract<AfterEvent, { status: "completed" }>

const completed = (event: { tool: string; input: unknown; result: Tool.Result }): CompletedEvent => ({
  tool: event.tool,
  sessionID,
  agent: toolIdentity.agent,
  messageID: toolIdentity.messageID,
  id: Tool.CallID.make("call-1"),
  input: event.input,
  status: "completed",
  result: event.result,
})

const fileDiff = (file: string) => ({ file, patch: "", additions: 1, deletions: 0, status: "modified" as const })

/** The text of a tool result whose content the hook may have rewritten into parts. */
const text = (content: unknown) =>
  Array.isArray(content)
    ? content.map((part: { text?: string }) => part.text ?? "").join("")
    : typeof content === "string"
      ? content
      : ""

describe("fork lsp: the lsp tool", () => {
  it.live("answers hover from the configured server", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({
        lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_RESULTS: JSON.stringify({ "textDocument/hover": { contents: "hint" } }) }) },
      })
      yield* write(directory, "src/a.ts")
      const result = yield* run("lsp", { operation: "hover", path: "src/a.ts", line: 1, character: 1 })
      expect(result.status).toBe("completed")
      expect(JSON.stringify(result.content)).toContain("hint")
      expect(result.metadata).toMatchObject({ operation: "hover", path: "src/a.ts", results: 1 })
    }),
  )

  it.live("answers document symbols without a position", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({
        lsp: {
          fake: fakeEntry([".ts"], {
            FAKE_LSP_RESULTS: JSON.stringify({ "textDocument/documentSymbol": [{ name: "alpha", kind: 12 }] }),
          }),
        },
      })
      yield* write(directory, "src/a.ts")
      const result = yield* run("lsp", { operation: "documentSymbol", path: "src/a.ts" })
      expect(result.status).toBe("completed")
      expect(JSON.stringify(result.content)).toContain("alpha")
    }),
  )

  it.live("caps document symbols at two hundred and reports the remainder", () =>
    Effect.gen(function* () {
      const symbols = Array.from({ length: 250 }, (_, index) => ({ name: `sym-${index}`, kind: 12 }))
      const { directory, run } = yield* prepare({
        lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_RESULTS: JSON.stringify({ "textDocument/documentSymbol": symbols }) }) },
      })
      yield* write(directory, "src/a.ts")
      const result = yield* run("lsp", { operation: "documentSymbol", path: "src/a.ts" })
      expect(result.status).toBe("completed")
      const content = text(result.content)
      expect(content).toContain("sym-199")
      expect(content).not.toContain("sym-200")
      expect(content).toContain("and 50 more results")
      expect(result.metadata).toMatchObject({ operation: "documentSymbol", results: 250 })
    }),
  )

  it.live("caps workspace symbols per server", () =>
    Effect.gen(function* () {
      const symbols = Array.from({ length: 250 }, (_, index) => ({ name: `sym-${index}`, kind: 12 }))
      const { directory, run } = yield* prepare({
        lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_RESULTS: JSON.stringify({ "workspace/symbol": symbols }) }) },
      })
      yield* write(directory, "src/a.ts")
      // workspaceSymbol serves only running servers, so start one by touching the file first.
      yield* run("lsp", { operation: "documentSymbol", path: "src/a.ts" })
      const result = yield* run("lsp", { operation: "workspaceSymbol", path: "src/a.ts", query: "sym" })
      expect(result.status).toBe("completed")
      const content = text(result.content)
      expect(content).toContain("sym-9")
      expect(content).not.toContain("sym-10")
      expect(result.metadata).toMatchObject({ operation: "workspaceSymbol", results: 10 })
    }),
  )

  it.live("says so when a query matches nothing", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({ lsp: { fake: fakeEntry([".ts"]) } })
      yield* write(directory, "src/a.ts")
      const result = yield* run("lsp", { operation: "documentSymbol", path: "src/a.ts" })
      expect(result.status).toBe("completed")
      expect(JSON.stringify(result.content)).toContain("No results found for documentSymbol")
    }),
  )

  it.live("requires a position for position-bound operations", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({ lsp: { fake: fakeEntry([".ts"]) } })
      yield* write(directory, "src/a.ts")
      const result = yield* run("lsp", { operation: "goToDefinition", path: "src/a.ts" })
      expect(result.status).toBe("error")
      expect(JSON.stringify(result)).toContain("goToDefinition requires line and character")
    }),
  )

  it.live("refuses files outside the project and missing files", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({ lsp: { fake: fakeEntry([".ts"]) } })
      yield* write(path.join(directory, ".."), "outside.ts")
      const outside = yield* run("lsp", { operation: "hover", path: "../outside.ts", line: 1, character: 1 })
      expect(outside.status).toBe("error")
      expect(JSON.stringify(outside)).toContain("outside the project")
      const missing = yield* run("lsp", { operation: "hover", path: "src/missing.ts", line: 1, character: 1 })
      expect(missing.status).toBe("error")
      expect(JSON.stringify(missing)).toContain("File not found")
    }),
  )

  it.live("refuses file types no configured server handles", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* prepare({ lsp: { fake: fakeEntry([".ts"]) } })
      yield* write(directory, "style.css")
      const result = yield* run("lsp", { operation: "documentSymbol", path: "style.css" })
      expect(result.status).toBe("error")
      expect(JSON.stringify(result)).toContain("No LSP server available for this file type")
    }),
  )
})

describe("fork lsp: the edit/write/patch diagnostics hook", () => {
  it.live("appends an error block to an edit result and mirrors it in metadata", () =>
    Effect.gen(function* () {
      const { directory, fire } = yield* prepare({ lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LINT: "1" }) } })
      yield* write(directory, "src/err.ts", "ERROR: broken thing\nfine\n")
      const event = completed({
        tool: "edit",
        input: { path: "src/err.ts" },
        result: { content: "Edited", output: { files: [fileDiff("src/err.ts")], replacements: 1 } },
      })
      yield* fire(event)
      const content = text(event.result.content)
      expect(content).toContain("Edited")
      expect(content).toContain("LSP errors detected in this file, please fix:")
      expect(content).toContain('<diagnostics file="src/err.ts">')
      expect(content).toContain("ERROR [1:1] broken thing")
      const diagnostics = (event.result.metadata as { diagnostics: Record<string, unknown> }).diagnostics
      expect(diagnostics["src/err.ts"]).toMatchObject([{ severity: 1, message: "broken thing" }])
    }),
  )

  it.live("reports files a write may have broken, up to five, and ignores warns", () =>
    Effect.gen(function* () {
      const { directory, fire } = yield* prepare({ lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LINT: "1" }) } })
      yield* write(directory, "src/b.ts", "ERROR: dependent breakage\n")
      yield* write(directory, "src/a.ts", "ERROR: main issue\nWARN: minor\n")
      // Open the dependent file first so the server knows about it when the write happens.
      yield* fire(
        completed({
          tool: "edit",
          input: { path: "src/b.ts" },
          result: { content: "Edited", output: { files: [fileDiff("src/b.ts")], replacements: 1 } },
        }),
      )
      const event = completed({
        tool: "write",
        input: { path: path.join(directory, "src/a.ts") },
        result: {
          content: "Wrote",
          output: { operation: "write", target: path.join(directory, "src/a.ts"), resource: "src/a.ts", existed: true },
        },
      })
      yield* fire(event)
      const content = text(event.result.content)
      expect(content).toContain("LSP errors detected in this file, please fix:")
      expect(content).toContain("ERROR [1:1] main issue")
      expect(content).not.toContain("minor")
      expect(content).toContain("LSP errors detected in other files:")
      expect(content).toContain('<diagnostics file="src/b.ts">')
      expect(content).toContain("ERROR [1:1] dependent breakage")
    }),
  )

  it.live("leaves results alone once the diagnostics budget is spent", () =>
    Effect.gen(function* () {
      const { directory, fire } = yield* prepare({
        lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LINT: "1", FAKE_LSP_DELAY_MS: "5000" }) },
        plugin: { budget: "300 millis" },
      })
      yield* write(directory, "src/slow.ts", "ERROR: late finding\n")
      const event = completed({
        tool: "edit",
        input: { path: "src/slow.ts" },
        result: { content: "Edited", output: { files: [fileDiff("src/slow.ts")], replacements: 1 } },
      })
      yield* fire(event)
      expect(event.result.content).toBe("Edited")
      expect(event.result.metadata).toBeUndefined()
    }),
  )

  it.live("ignores other tools and failed executions", () =>
    Effect.gen(function* () {
      const { directory, fire } = yield* prepare({ lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LINT: "1" }) } })
      yield* write(directory, "src/err.ts", "ERROR: broken thing\n")
      const shell = completed({ tool: "shell", input: { command: "true" }, result: { content: "ok" } })
      yield* fire(shell)
      expect(shell.result.content).toBe("ok")
      const failed: AfterEvent = {
        tool: "edit",
        sessionID,
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
        id: Tool.CallID.make("call-1"),
        input: { path: "src/err.ts" },
        status: "error",
        error: new Tool.Error({ message: "failed" }),
      }
      yield* fire(failed)
      expect(failed.error.message).toContain("failed")
    }),
  )

  it.live("warms a server when a file is read", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const log = path.join(tmp.path, "fake-lsp.log")
      const { directory, fire } = yield* prepare({ lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LOG: log }) } })
      yield* write(directory, "src/warm.ts")
      yield* fire(completed({ tool: "read", input: { path: "src/warm.ts" }, result: { content: "content" } }))
      let received = ""
      for (let index = 0; index < 200; index++) {
        received = yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))
        if (received.includes("textDocument/didOpen")) break
        yield* Effect.sleep("25 millis")
      }
      expect(received).toContain("textDocument/didOpen")
    }),
  )

  it.live("does not warm a server for a read inside node_modules", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const log = path.join(tmp.path, "fake-lsp.log")
      const { directory, fire } = yield* prepare({ lsp: { fake: fakeEntry([".ts"], { FAKE_LSP_LOG: log }) } })
      yield* write(directory, "node_modules/pkg/index.ts")
      yield* fire(completed({ tool: "read", input: { path: "node_modules/pkg/index.ts" }, result: { content: "content" } }))
      // A project read right after warms the server, so the assertions below cannot pass because the hook
      // never ran: the missing dependency path is the guard doing its job.
      yield* write(directory, "src/warm.ts")
      yield* fire(completed({ tool: "read", input: { path: "src/warm.ts" }, result: { content: "content" } }))
      let received = ""
      for (let index = 0; index < 200; index++) {
        received = yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))
        if (received.includes("src/warm.ts")) break
        yield* Effect.sleep("25 millis")
      }
      expect(received).toContain("src/warm.ts")
      expect(received).not.toContain("node_modules")
    }),
  )
})
