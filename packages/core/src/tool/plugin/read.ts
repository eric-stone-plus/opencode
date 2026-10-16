export * as ReadTool from "./read.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { basename, dirname, join } from "path"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Escape } from "../../fork/escape.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { AbsolutePath } from "../../schema.js"
import { ReadToolFileSystem } from "../read-filesystem.js"
import { Environment } from "../../environment/index.js"
import { ForkPdfText } from "../fork/pdf-text.js"

export const name = "read"
const FILENAME = "AGENTS.md"
// Read-triggered guidance is model-visible context on THIS tool result, not session state:
// nothing is published and nothing persists, so a read cannot drift the session's instruction
// context. The envelope mirrors the instruction-entry block, and every path and body is escaped
// because an AGENTS.md is project-controlled and must not forge a tag or close the envelope.
const CONTEXT_KEY = "read-instructions"
// The body budget mirrors the fork's per-file instruction budget (plugin/fork/instructions.ts,
// MAX_INSTRUCTION_BYTES = 12000): a read must never balloon its result with a tree's AGENTS.md.
const MAX_CONTEXT_BYTES = 12_000
const LocationInput = Schema.Struct({
  path: Schema.String.annotate({ description: "File or directory to read" }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
})
export const Input = LocationInput
const Output = Schema.Union([ReadToolFileSystem.FileContent, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

export const Plugin = {
  id: "opencode.tool.read",
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    const reader = yield* ReadToolFileSystem.Service
    const access = yield* FileAccess.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const environment = yield* Environment.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images are presented directly to the model; PDFs are read as extracted text. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              const read = (target: FileAccess.Target) =>
                reader.read(target.absolute, target.resource, {
                  offset: input.offset,
                  limit: input.limit,
                })

              const requested = yield* access.authorizeRead(input.path, context)
              const result = yield* read(requested).pipe(
                Effect.map((content) => ({ content, target: requested, path: input.path })),
                Effect.catchIf(
                  (error) => error instanceof Environment.NotFound,
                  () =>
                    Effect.gen(function* () {
                      const alternate = yield* alternatePath(requested.absolute).pipe(
                        Effect.orElseSucceed(() => undefined),
                      )
                      if (!alternate) return yield* missing(input.path, requested.absolute)
                      const target = yield* access.authorizeRead(alternate, context, { siblingOf: requested })
                      const content = yield* read(target).pipe(
                        Effect.catchIf(
                          (error) => error instanceof Environment.NotFound,
                          () => missing(input.path, requested.absolute),
                        ),
                      )
                      if (content.type === "list-page") return yield* missing(input.path, requested.absolute)
                      return {
                        content,
                        target,
                        path: join(dirname(input.path), basename(alternate)),
                      }
                    }),
                ),
              )
              // After a successful read, discover nearby AGENTS.md and append them to THIS result as
              // model-visible context. The walk starts at the read directory (a directory listing's
              // own AGENTS.md included); it is bounded by the nearest declared root, so an AGENTS.md
              // above the declaration is never consulted, and with no declaration covering the
              // target nothing is injected at all. External reads are skipped, the read file itself
              // is never repeated, the Location root's already-supplied ancestors are excluded, and
              // discovery failures never fail the read.
              const instructionContext = yield* Effect.gen(function* () {
                if (result.target.externalDirectory !== undefined) return
                const trust = discovery.trust
                const resolved = yield* fs.resolve(result.target.absolute)
                const start = result.content.type === "list-page" ? resolved : dirname(resolved)
                const root = yield* fs.resolve(location.directory)
                const bound = trust.data.all ? root : trust.nearestRoot(start)
                if (bound === undefined) return
                const discovered = yield* fs.up({ targets: [FILENAME], start, stop: bound, type: "file" })
                // The Location and its ancestors are already supplied by initial instructions,
                // even when an upward walk from elsewhere in the project cannot reach root.
                const candidates = (yield* Effect.forEach(discovered, fs.resolve)).filter(
                  (file) => !FSUtil.contains(dirname(file), root) && file !== resolved,
                )
                if (candidates.length === 0) return
                const files = yield* Effect.forEach(
                  candidates,
                  (path) =>
                    fs
                      .readFileStringSafe(path)
                      .pipe(Effect.map((content) => (content === undefined ? undefined : { path, content }))),
                  { concurrency: "unbounded" },
                )
                const readable = files.filter((file): file is { path: string; content: string } => file !== undefined)
                if (readable.length === 0) return
                return renderInstructionContext(readable)
              }).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
                Effect.catchDefect(() => Effect.succeed(undefined)),
              )
              // PDFs are read as text and never attached: inline media is dead weight for text-only models and is
              // persisted with the session.
              if (result.content.type === "file" && result.content.mime === "application/pdf") {
                const text = yield* ForkPdfText.extract(environment.spawner, result.target.absolute)
                if (text === undefined) return yield* new ToolFailure({ message: ForkPdfText.unreadable(result.path) })
                return {
                  output: { ...result.content, content: text, encoding: "utf8" as const },
                  path: result.path,
                  context: instructionContext,
                }
              }
              if (
                result.content.type === "file" &&
                result.content.encoding === "base64" &&
                !ReadToolFileSystem.MEDIA_MIMES.has(result.content.mime)
              )
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource: result.target.resource }))
              return { output: result.content, path: result.path, context: instructionContext }
            }).pipe(
              Effect.map((result) => {
                const content = toModelContent(result.path, input.offset, result.output)
                return {
                  output: result.output,
                  content:
                    result.context === undefined
                      ? content
                      : typeof content === "string"
                        ? `${content}\n\n${result.context}`
                        : [...content, { type: "text" as const, text: result.context }],
                  metadata: { truncated: result.output.type === "file" ? false : result.output.truncated },
                }
              }),
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.PathKindError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message, error })
              }),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const alternatePath = Effect.fn("ReadTool.alternatePath")(function* (absolute: string) {
      const canonical = (name: string) =>
        name
          .normalize("NFC")
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/[\u2018\u2019]/g, "'")
      const base = canonical(basename(absolute))
      const matches = (yield* reader.list(AbsolutePath.make(dirname(absolute)))).filter(
        (entry) => entry.type === "file" && canonical(entry.name) === base,
      )
      if (matches.length !== 1) return
      return join(dirname(absolute), matches[0].name)
    })

    const missing = Effect.fn("ReadTool.missing")(function* (input: string, absolute: string) {
      const base = basename(input).toLowerCase()
      const suggestions = yield* fs.readDirectory(dirname(absolute)).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => {
              const candidate = entry.toLowerCase()
              return candidate.includes(base) || base.includes(candidate)
            })
            .map((entry) => join(dirname(input), entry))
            .slice(0, 3),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      )
      const message =
        suggestions.length === 0
          ? `File not found: ${input}`
          : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
      return yield* new ToolFailure({ message })
    })
  }),
}

export const toModelContent = (path: string, offset: number | undefined, output: typeof Output.Type) => {
  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => content.push(entry.path))
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  // Pages already join selected lines; a trailing newline represents a selected blank line.
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const lines = output.content === "" ? [] : text.split("\n")
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  return content.join("\n")
}

// The envelope and both escaping layers are part of the trust boundary: `Instructions from:`
// labels each file's source, the body is text-escaped, and a byte cut drops a half-written
// entity so the escaped body stays parseable.
const renderInstructionContext = (files: ReadonlyArray<{ readonly path: string; readonly content: string }>) => {
  const body = files
    .map((file) => `Instructions from: ${Escape.escapeLine(file.path)}\n${Escape.escapeText(file.content)}`)
    .join("\n\n")
  return [`<context key="${CONTEXT_KEY}">`, capContextBody(body), "</context>"].join("\n")
}

const capContextBody = (body: string) => {
  const size = Buffer.byteLength(body, "utf8")
  if (size <= MAX_CONTEXT_BYTES) return body
  const head = Buffer.from(body, "utf8")
    .subarray(0, MAX_CONTEXT_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/, "")
  const kept = head.replace(/&[a-z]*$/i, "")
  return `${kept}\n\n[... ${size - Buffer.byteLength(kept, "utf8")} bytes omitted: context budget]`
}
