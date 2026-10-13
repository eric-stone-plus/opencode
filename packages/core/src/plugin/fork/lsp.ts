export * as LSPPlugin from "./lsp.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { ForkLsp } from "@opencode/schema/fork-lsp"
import { Cause, Effect, Option, Schema } from "effect"
import type { Duration } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { LSPDiagnostic } from "../../fork/lsp/diagnostic.js"
import { LSP } from "../../fork/lsp/lsp.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { PositiveInt } from "../../schema.js"
import { EditTool } from "../../tool/plugin/edit.js"
import { PatchTool } from "../../tool/plugin/patch.js"
import { WriteTool } from "../../tool/plugin/write.js"
import DESCRIPTION from "./lsp.txt"

export const name = "lsp"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Input = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  path: Schema.String.annotate({ description: "The file to operate on, absolute or relative to the working directory" }),
  line: Schema.optionalKey(PositiveInt).annotate({
    description:
      "The line number (1-based, as shown in editors). Required by every operation except documentSymbol and workspaceSymbol",
  }),
  character: Schema.optionalKey(PositiveInt).annotate({
    description:
      "The character offset (1-based, as shown in editors). Required by every operation except documentSymbol and workspaceSymbol",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Search query for workspaceSymbol. An empty string requests all symbols.",
  }),
})

/** How long an edit, write, or patch waits for a language server before returning its result without diagnostics. */
export const DIAGNOSTICS_BUDGET: Duration.Input = "15 seconds"
/** A slow server must not hold a tool call forever; a start that outlives the budget continues in the background. */
export const TOOL_TIMEOUT = "60 seconds"
// A write also reports errors it may have caused elsewhere, but only a few files' worth.
export const MAX_OTHER_FILES = 5
// A references or symbols query on a busy symbol can return thousands of entries; the model needs the first ones.
export const MAX_RESULTS = 200

const decodeEdit = Schema.decodeUnknownOption(EditTool.Output)
const decodeWrite = Schema.decodeUnknownOption(WriteTool.Output)
const decodePatch = Schema.decodeUnknownOption(PatchTool.Output)
const decodeInputPath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }))

export interface Options extends LSP.Options {
  readonly budget?: Duration.Input
}

export const make = (options: Options = {}) =>
  define({
  id: "fork.lsp",
  effect: Effect.fn("LSPPlugin")(function* (ctx) {
    const lsp = yield* LSP.make(options)
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const scope = yield* Effect.scope

    // Shown to the model the way its own tools name files: relative inside the Location, absolute outside.
    const display = (file: string) =>
      path.relative(location.directory, file).startsWith("..") ? file : path.relative(location.directory, file).replaceAll("\\", "/")

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description: DESCRIPTION,
        input: Input,
        execute: (input, context) =>
          Effect.gen(function* () {
            const target = yield* access.resolve({ path: input.path, kind: "file" })
            if (target.externalDirectory)
              return yield* new ToolFailure({
                message: `${input.path} is outside the project; the lsp tool only works on project files.`,
              })
            yield* permission.assert({
              action: name,
              resources: [target.resource],
              save: ["*"],
              metadata: { operation: input.operation, path: target.resource, line: input.line, character: input.character },
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            yield* environment.files.stat(target.absolute).pipe(
              Effect.mapError((error) =>
                error instanceof Environment.NotFound
                  ? new ToolFailure({ message: `File not found: ${input.path}` })
                  : new ToolFailure({ message: `Unable to read ${input.path}`, error }),
              ),
            )
            if (!(yield* lsp.hasClients(target.absolute)))
              return yield* new ToolFailure({ message: "No LSP server available for this file type." })

            const file = target.absolute
            // Notifications are ordered on the connection, so the request that follows sees the current content.
            yield* lsp.touchFile(file)
            const position = () => {
              if (input.line === undefined || input.character === undefined)
                return new ToolFailure({ message: `${input.operation} requires line and character.` })
              return { file, line: input.line - 1, character: input.character - 1 }
            }
            const run = Effect.gen(function* () {
              if (input.operation === "documentSymbol") return yield* lsp.documentSymbol(file)
              if (input.operation === "workspaceSymbol") return yield* lsp.workspaceSymbol(input.query ?? "")
              const at = position()
              if (at instanceof ToolFailure) return yield* at
              switch (input.operation) {
                case "goToDefinition":
                  return yield* lsp.definition(at)
                case "findReferences":
                  return yield* lsp.references(at)
                case "hover":
                  return yield* lsp.hover(at)
                case "goToImplementation":
                  return yield* lsp.implementation(at)
                case "prepareCallHierarchy":
                  return yield* lsp.prepareCallHierarchy(at)
                case "incomingCalls":
                  return yield* lsp.incomingCalls(at)
                case "outgoingCalls":
                  return yield* lsp.outgoingCalls(at)
              }
            })
            const result = yield* run.pipe(
              Effect.timeoutOrElse({
                duration: TOOL_TIMEOUT,
                orElse: () => Effect.fail(new ToolFailure({ message: `LSP ${input.operation} timed out.` })),
              }),
            )
            const shown = result.slice(0, MAX_RESULTS)
            return {
              content:
                result.length === 0
                  ? `No results found for ${input.operation}`
                  : JSON.stringify(shown, null, 2) +
                    (result.length > shown.length ? `\n... and ${result.length - shown.length} more results` : ""),
              metadata: { operation: input.operation, path: target.resource, results: result.length },
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to run ${input.operation}`, error }),
            ),
          ),
      }),
    )

    // Files whose content a completed edit, write, or patch changed, as absolute paths.
    const changed = (tool: string, output: unknown): string[] => {
      if (tool === "edit")
        return Option.toArray(decodeEdit(output)).flatMap((result) =>
          result.files.map((item) => FileAccess.resolvePath(location.directory, item.file)),
        )
      if (tool === "write") return Option.toArray(decodeWrite(output)).map((result) => result.target)
      return Option.toArray(decodePatch(output)).flatMap((result) =>
        result.applied.filter((item) => item.type !== "delete").map((item) => item.target),
      )
    }

    const report = Effect.fnUntraced(function* (event: {
      readonly tool: string
      readonly input: unknown
      result: { content?: unknown; metadata?: unknown; output?: unknown }
    }) {
      const files = changed(event.tool, event.result.output)
      if (files.length === 0) return undefined
      yield* Effect.forEach(files, (file) => lsp.touchFile(file, "document"), { concurrency: "unbounded", discard: true })
      const known = yield* lsp.diagnostics()
      const own = (file: string) => LSPDiagnostic.report(display(file), known[file] ?? [])
      const sections = files.flatMap((file) => {
        const block = own(file)
        if (!block) return []
        return [`\n\nLSP errors detected in ${event.tool === "patch" ? display(file) : "this file"}, please fix:\n${block}`]
      })
      // A write can break files that depend on it; report the ones the servers know about, a few at most.
      const others =
        event.tool === "write"
          ? Object.entries(known)
              .filter(([file]) => !files.includes(file))
              .flatMap(([file, issues]) => {
                const block = LSPDiagnostic.report(display(file), issues)
                return block ? [`\n\nLSP errors detected in other files:\n${block}`] : []
              })
              .slice(0, MAX_OTHER_FILES)
          : []
      if (sections.length === 0 && others.length === 0) return undefined
      const shown = Object.fromEntries(
        [...files, ...Object.keys(known).filter((file) => !files.includes(file))].flatMap((file) => {
          const errors = (known[file] ?? []).filter((item) => item.severity === 1).slice(0, LSPDiagnostic.MAX_PER_FILE)
          return errors.length === 0 ? [] : [[file, errors] as const]
        }),
      )
      // The clients look diagnostics up by the path the model passed, which may be relative.
      const inputPath = Option.getOrUndefined(decodeInputPath(event.input))?.path
      const key = inputPath !== undefined && files.length === 1 ? { [inputPath]: shown[files[0]] ?? [] } : {}
      return { text: [...sections, ...others].join(""), diagnostics: { ...shown, ...key } }
    })

    // Waiting on a language server must never fail or stall the edit that already happened.
    const feedback = (event: Parameters<typeof report>[0]) =>
      report(event).pipe(
        Effect.timeoutOption(options.budget ?? DIAGNOSTICS_BUDGET),
        Effect.map(Option.flatMap(Option.fromUndefinedOr)),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logWarning("failed to collect LSP diagnostics", { cause }).pipe(Effect.as(Option.none())),
        ),
        Effect.tap((found) =>
          Effect.sync(() => {
            if (Option.isNone(found)) return
            const content = event.result.content
            const items =
              typeof content === "string" ? [{ type: "text" as const, text: content }] : Array.isArray(content) ? [...content] : []
            const last = items.at(-1)
            event.result.content =
              last?.type === "text"
                ? [...items.slice(0, -1), { ...last, text: last.text + found.value.text }]
                : [...items, { type: "text" as const, text: found.value.text.trimStart() }]
            event.result.metadata = { ...(event.result.metadata as object | undefined), diagnostics: found.value.diagnostics }
          }),
        ),
        Effect.asVoid,
      )

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return Effect.void
      if (event.tool === "edit" || event.tool === "write" || event.tool === "patch") return feedback(event)
      if (event.tool !== "read") return Effect.void
      // Reading a file warms the matching server so the first diagnostics wait is short. Best effort and unawaited.
      const read = Option.getOrUndefined(decodeInputPath(event.input))
      if (!read) return Effect.void
      const file = FileAccess.resolvePath(location.directory, read.path)
      // A dependency read is not project work: warming a server for one would start - and keep - a server
      // rooted in an installed package for every `node_modules` tree the session happens to read.
      if (file.split(path.sep).includes("node_modules")) return Effect.void
      return lsp
        .touchFile(file)
        .pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning("failed to warm LSP server", { cause }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
    })

    const resolve = (file: string) => FileAccess.resolvePath(location.directory, file)
    yield* ctx.rpc
      .register(ForkLsp.Definition, {
        status: () => lsp.status(),
        diagnostics: ({ path: file }) =>
          lsp.touchFile(resolve(file), "full").pipe(Effect.andThen(lsp.diagnostics())),
        workspaceSymbols: ({ query, path: file }) =>
          (file === undefined ? Effect.void : lsp.touchFile(resolve(file))).pipe(
            Effect.andThen(lsp.workspaceSymbol(query)),
          ),
        documentSymbols: ({ path: file }) =>
          lsp.touchFile(resolve(file)).pipe(Effect.andThen(lsp.documentSymbol(resolve(file)))),
      })
      .pipe(Effect.orDie)
  }),
})

export const Plugin = make()
