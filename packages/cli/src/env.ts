import { Config, Effect, Redacted } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

// A session-bound credential injected by the agent shell. It takes precedence over the
// operator password so a CLI launched from that shell cannot act as the operator. Read
// process.env directly: tests and long-lived processes may set it after the runtime starts.
export const sessionToken = Effect.sync(() => {
  const value = process.env.OPENCODE_SESSION_TOKEN
  return value ? Redacted.make(value) : undefined
})

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "OPENCODE_PASSWORD" &&
        entry[0] !== "OPENCODE_SERVER_PASSWORD" &&
        entry[0] !== "OPENCODE_SESSION_TOKEN",
    ),
  )
}

export * as Env from "./env"
