export * as LSPDiagnostic from "./diagnostic.js"

import { ForkLsp } from "@opencode/schema/fork-lsp"
import { Option, Schema } from "effect"
// Server text is untrusted: `&`, `<`, `>` become entities and line breaks collapse, so neither a path
// nor a message can close the block or forge another entry inside it.
import { Escape } from "../escape.js"

export const MAX_PER_FILE = 20
// Compilers can emit multi-kilobyte explanations; the model needs the gist, not the whole trace.
const MAX_MESSAGE_CHARACTERS = 1_000

export const Info = ForkLsp.Diagnostic
export type Info = ForkLsp.Diagnostic

const decodeInfo = Schema.decodeUnknownOption(Info)

/** Keeps every well-formed diagnostic; one malformed entry must not discard a file's whole list. */
export const parse = (items: ReadonlyArray<unknown>): Info[] => items.flatMap((item) => Option.toArray(decodeInfo(item)))

/** Servers disagree on `source` and `code` for one finding, so equality is severity, range, and message. */
export const identity = (item: Info) =>
  `${item.severity}:${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}:${item.message}`

// A missing or out-of-range severity is treated as an error so it stays visible; `pretty` and `report`
// must not disagree about which findings exist.
const severityLevel = (diagnostic: Info) => {
  const severity = diagnostic.severity ?? 1
  return severity >= 1 && severity <= 4 ? severity : 1
}

export function pretty(diagnostic: Info) {
  const severity = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }[severityLevel(diagnostic)] ?? "ERROR"
  const message =
    diagnostic.message.length > MAX_MESSAGE_CHARACTERS
      ? `${[...diagnostic.message].slice(0, MAX_MESSAGE_CHARACTERS).join("")}...`
      : diagnostic.message
  return `${severity} [${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}] ${Escape.escapeLine(message)}`
}

/** The model-facing block for one file: error-level findings only, at most `MAX_PER_FILE`. */
export function report(file: string, issues: ReadonlyArray<Info>) {
  const errors = issues.filter((item) => severityLevel(item) === 1)
  if (errors.length === 0) return ""
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${Escape.escapeAttribute(file)}">\n${errors.slice(0, MAX_PER_FILE).map(pretty).join("\n")}${suffix}\n</diagnostics>`
}
