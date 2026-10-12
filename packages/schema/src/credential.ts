export * as Credential from "./credential.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { IntegrationID, IntegrationMethodID } from "./integration-id.js"
import { ascending } from "./identifier.js"
import { NonNegativeInt, statics } from "./schema.js"
import { Form } from "./form.js"

export const ID = Schema.String.pipe(
  Schema.brand("Credential.ID"),
  Schema.annotate({ identifier: "Credential.ID" }),
  statics((schema) => ({ create: () => schema.make("cred_" + ascending()) })),
)
export type ID = typeof ID.Type

const Updated = ephemeral({
  type: "credential.updated",
  schema: {},
})
const Switched = ephemeral({
  type: "credential.switched",
  schema: { integrationID: IntegrationID, credentialID: Schema.NullOr(ID) },
})
export const Event = {
  Updated,
  Switched,
  Definitions: inventory(Updated, Switched),
}

export interface OAuth extends Schema.Schema.Type<typeof OAuth> {}
export const OAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  methodID: IntegrationMethodID,
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Credential.OAuth" })

export interface Key extends Schema.Schema.Type<typeof Key> {}
export const Key = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  configuration: optional(Form.Answer),
}).annotate({ identifier: "Credential.Key" })

/** References a credential source whose secrets and renewal are managed outside the credential store. */
export interface External extends Schema.Schema.Type<typeof External> {}
export const External = Schema.Struct({
  type: Schema.Literal("external"),
  methodID: IntegrationMethodID,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Credential.External" })

export const Value = Schema.Union([OAuth, Key, External])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Credential.Value" })
export type Value = Schema.Schema.Type<typeof Value>

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  id: ID,
  integrationID: IntegrationID,
  label: Schema.String,
  active: Schema.Boolean,
  value: Value,
}).annotate({ identifier: "Credential.Entry" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  id: optional(ID),
  integrationID: IntegrationID,
  label: optional(Schema.String),
  value: Value,
  activate: optional(Schema.Boolean),
}).annotate({ identifier: "Credential.CreateInput" })

/**
 * Removes every stored credential of the listed integrations, or of all integrations, and optionally
 * sweeps other copies of the removed secret values. Every flag is off when omitted.
 */
export interface PurgeInput extends Schema.Schema.Type<typeof PurgeInput> {}
export const PurgeInput = Schema.Struct({
  integrationIDs: optional(Schema.Array(IntegrationID)),
  /** Purge every integration; exclusive with `integrationIDs`. */
  all: optional(Schema.Boolean),
  /** Sweep stale copies by value in the server host's credential files and environment. */
  files: optional(Schema.Boolean),
  /** Redact the values in session history, saved tool output, and logs. */
  history: optional(Schema.Boolean),
  /** Rewrite the database file when redaction left copies in its free pages. */
  compact: optional(Schema.Boolean),
  /** Report what would change without changing anything. */
  dryRun: optional(Schema.Boolean),
}).annotate({ identifier: "Credential.PurgeInput" })

export interface PurgeCredential extends Schema.Schema.Type<typeof PurgeCredential> {}
export const PurgeCredential = Schema.Struct({
  id: ID,
  integrationID: IntegrationID,
  label: Schema.String,
  /** False while previewing or when the removal failed. */
  removed: Schema.Boolean,
}).annotate({ identifier: "Credential.PurgeCredential" })

/** One place a copy of a secret value was found. `location` names a path, table column, or variable, never a value. */
export interface PurgeLocation extends Schema.Schema.Type<typeof PurgeLocation> {}
export const PurgeLocation = Schema.Struct({
  kind: Schema.Literals([
    "credential",
    "auth",
    "env",
    "environment.d",
    "service",
    "systemd",
    "process",
    "database",
    "tool-output",
    "log",
  ]),
  location: Schema.String,
  /** Entries, lines, variables, rows, or files, depending on the kind. */
  count: NonNegativeInt,
  /** An error code when the location could not be processed. */
  error: optional(Schema.String),
}).annotate({ identifier: "Credential.PurgeLocation" })

export interface PurgeCompact extends Schema.Schema.Type<typeof PurgeCompact> {}
export const PurgeCompact = Schema.Struct({
  status: Schema.Literals(["done", "skipped", "failed"]),
  reason: optional(Schema.String),
}).annotate({ identifier: "Credential.PurgeCompact" })

/** What a purge removed or, for a dry run, would remove. It never contains a secret value. */
export interface PurgeResult extends Schema.Schema.Type<typeof PurgeResult> {}
export const PurgeResult = Schema.Struct({
  dryRun: Schema.Boolean,
  credentials: Schema.Array(PurgeCredential),
  secrets: Schema.Struct({
    /** Distinct secret values searched for. */
    distinct: NonNegativeInt,
    /** Values left alone because a credential outside the purge still holds them. */
    shared: NonNegativeInt,
    /** Values left alone because they are too short to search for safely. */
    short: NonNegativeInt,
  }),
  swept: Schema.Array(PurgeLocation),
  /** Copies still found by the verification pass that follows a sweep. */
  remaining: Schema.Array(PurgeLocation),
  compact: optional(PurgeCompact),
}).annotate({ identifier: "Credential.PurgeResult" })
