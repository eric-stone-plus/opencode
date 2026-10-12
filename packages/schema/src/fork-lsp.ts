export * as ForkLsp from "./fork-lsp.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { NonNegativeInt, optional } from "./schema.js"

export const Position = Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt })

export const Range = Schema.Struct({ start: Position, end: Position })
export type Range = typeof Range.Type

/** The subset of a language-server diagnostic the runtime keeps; positions are zero-based. */
export const Diagnostic = Schema.Struct({
  range: Range,
  severity: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  source: Schema.optionalKey(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "Lsp.Diagnostic" })
export type Diagnostic = typeof Diagnostic.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "Lsp.Status" })
export type Status = typeof Status.Type

const Path = Schema.Struct({ path: Schema.String })

/** Server-side LSP inspection for `opencode debug lsp`. Paths resolve against the request's Location. */
export const Definition = Rpc.define({
  id: "fork.lsp",
  methods: {
    status: { input: Schema.Struct({}), output: Schema.Array(Status) },
    /** Opens the file in every matching server, waits for them to report, and returns all known diagnostics by absolute path. */
    diagnostics: { input: Path, output: Schema.Record(Schema.String, Schema.Array(Diagnostic)) },
    /** Searches the running servers; `path` starts the servers that match it first. */
    workspaceSymbols: {
      input: Schema.Struct({ query: Schema.String, path: optional(Schema.String) }),
      output: Schema.Array(Schema.Unknown),
    },
    documentSymbols: { input: Path, output: Schema.Array(Schema.Unknown) },
  },
  events: {},
})
