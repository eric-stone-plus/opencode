import { Service, type Endpoint, type EnsureOptions } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Redacted } from "effect"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  readonly onStart?: EnsureOptions["onStart"]
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args = {}) {
  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  const sessionToken = yield* Env.sessionToken
  // An agent shell always carries OPENCODE_SESSION_ID. If its token is missing, fail instead of
  // falling back to the operator credential in the service config: a silent fallback would let a
  // shell read every session again.
  if (!sessionToken && (yield* Env.sessionID) !== undefined)
    return yield* Effect.fail(
      new Error("This agent shell has no session access token; refusing to use the operator credential"),
    )
  if (args.server !== undefined) {
    const password = yield* Env.password
    const endpoint = withSessionToken(
      {
        url: args.server,
        auth: password
          ? { type: "basic" as const, username: "opencode", password: Redacted.value(password) }
          : undefined,
      } satisfies Endpoint,
      sessionToken,
    )
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.server.info({ signal: AbortSignal.timeout(5_000) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (args.standalone || (yield* ServiceConfig.read()).disabled === true) {
    // A standalone server gets a fresh operator password and the shared database. Allowing a
    // session token to take this path would silently promote it to operator.
    if (sessionToken)
      return yield* Effect.fail(new Error("A session access token cannot start a standalone server"))
    return { endpoint: yield* Standalone.start() } satisfies Resolved
  }

  const mismatch = args.mismatch ?? "ignore"
  const options = yield* ServiceConfig.options({ checkVersion: mismatch !== "ignore" })
  return {
    endpoint: withSessionToken(yield* resolveManaged({ ...options, onStart: args.onStart }, mismatch), sessionToken),
    service: managedService(options, sessionToken),
  } satisfies Resolved
})

function withSessionToken(endpoint: Endpoint, token: Redacted.Redacted | undefined): Endpoint {
  if (!token) return endpoint
  return { ...endpoint, auth: { type: "basic", username: "opencode", password: Redacted.value(token) } }
}

function managedService(options: EnsureOptions, token: Redacted.Redacted | undefined) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions).pipe(Effect.map((endpoint) => withSessionToken(endpoint, token))),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop({ file: options.file, pty: "handoff" })
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

export const shutdownPersistentPty = Effect.fn("cli.server-connection.shutdown-persistent-pty")(function* (
  options: EnsureOptions,
) {
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise(() => client.experimental.persistentPty.shutdown())
})

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, mismatch: NonNullable<Args["mismatch"]>) {
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the credential`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}`, { cause })
  return new Error(`Server at ${endpoint.url} did not provide a compatible V2 health response`, { cause })
}

export * as ServerConnection from "./server-connection"
