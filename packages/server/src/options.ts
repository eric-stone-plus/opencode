import { Database } from "@opencode/core/database/database"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { ModelsDev } from "@opencode/core/models-dev"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Schema } from "effect"

export const ServerOptions = Schema.Struct({
  app: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
    }),
  ),
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  cors: Schema.optional(Schema.Array(Schema.String)),
  simulation: Schema.optional(Schema.Boolean),
  database: Schema.optional(Database.Options),
  pty: Schema.optional(PersistentPty.Options),
  events: Schema.optional(
    Schema.Struct({
      persist: Schema.optional(Schema.Boolean),
    }),
  ),
  models: Schema.optional(ModelsDev.Options),
  config: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      project: Schema.optional(Schema.Boolean),
      // The operator's trust declaration for project-side discovery. Host data only: it arrives
      // through these options and is never derived from a project's own files; an omitted value
      // is closed.
      trust: Schema.optional(
        Schema.Struct({
          all: Schema.Boolean,
          roots: Schema.Array(Schema.String),
        }),
      ),
      claude: Schema.optional(Schema.Boolean),
      file: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    }),
  ),
  windows: Schema.optional(
    Schema.Struct({
      gitbash: Schema.optional(Schema.String),
    }),
  ),
  fs: Schema.optional(
    Schema.Struct({
      filewatcher: Schema.optional(Schema.Boolean),
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type ServerOptions = typeof ServerOptions.Type

/**
 * Parses the operator's `trusted-roots` declaration with Core's parser. Exported here because
 * `packages/cli` may not import Core directly (packages/cli/test/import-boundaries.test.ts), while
 * the CLI must build `config.trust` from the same deterministic parser the server trusts: one
 * absolute path per line, `#` comments and blank lines skipped, and relative, glob-shaped, or
 * `~`-prefixed lines reported in `ignored` with a reason instead of being expanded.
 */
export function parseTrustDeclaration(text: string | undefined) {
  return ProjectTrust.parseRoots(text)
}
