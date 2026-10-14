export * as LSP from "./lsp.js"

import { Cause, Context, Deferred, Duration, Effect, Exit, Layer, Predicate, Scope } from "effect"
import { HttpClient } from "effect/http"
import path from "path"
import { pathToFileURL } from "url"
import type { Entry } from "@opencode/schema/config"
import { ForkLsp } from "@opencode/schema/fork-lsp"
import { LspEvent } from "@opencode/schema/lsp-event"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Location } from "../../location.js"
import { LSPClient } from "./client.js"
import { LSPDiagnostic } from "./diagnostic.js"
import { LSPServer } from "./server.js"
import { builtIns } from "./servers/index.js"

export const Status = ForkLsp.Status
export type Status = ForkLsp.Status

/** A zero-based position in a file, the way the protocol addresses it. */
export interface Position {
  readonly file: string
  readonly line: number
  readonly character: number
}

export interface Interface {
  readonly status: () => Effect.Effect<Status[]>
  /** Whether a configured server could analyse `file`: inside the project, a matching extension, not known broken. */
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  /**
   * Starts the matching servers if needed and sends them the file's current content. With `diagnostics` it
   * also waits, boundedly, for the servers to report on it. Never fails: a server that cannot start, crashes,
   * or stays silent only means there is nothing to report. Resolves with how many servers are handling the file.
   */
  readonly touchFile: (file: string, diagnostics?: LSPClient.WaitMode) => Effect.Effect<number>
  /** Diagnostics of every open document, merged across servers, keyed by absolute path. */
  readonly diagnostics: () => Effect.Effect<Record<string, LSPDiagnostic.Info[]>>
  /** What each matching server answered; servers with nothing to say are left out. */
  readonly hover: (input: Position) => Effect.Effect<unknown[]>
  readonly definition: (input: Position) => Effect.Effect<unknown[]>
  readonly references: (input: Position) => Effect.Effect<unknown[]>
  readonly implementation: (input: Position) => Effect.Effect<unknown[]>
  readonly documentSymbol: (file: string) => Effect.Effect<unknown[]>
  /** Searches the servers that are already running; start one with `touchFile` first. */
  readonly workspaceSymbol: (query: string) => Effect.Effect<unknown[]>
  readonly prepareCallHierarchy: (input: Position) => Effect.Effect<unknown[]>
  readonly incomingCalls: (input: Position) => Effect.Effect<unknown[]>
  readonly outgoingCalls: (input: Position) => Effect.Effect<unknown[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/fork/LSP") {}

// A server that crashes or fails to initialize is restarted with a capped exponential backoff and
// given up on after repeated quick failures, so a broken server cannot respawn in a hot loop. One that
// stayed up for a while starts over.
const RESTART_BASE_DELAY_MS = 2_000
const RESTART_MAX_DELAY_MS = 5 * 60_000
const RESTART_MAX_FAILURES = 8
const RESTART_HEALTHY_UPTIME_MS = 10 * 60_000
const WORKSPACE_SYMBOLS_PER_SERVER = 10
// The symbol kinds `workspaceSymbol` reports; the rest (fields, parameters, keys, ...) are noise at project scale.
const WORKSPACE_SYMBOL_KINDS = [5, 12, 6, 11, 13, 14, 23, 10]
// A location with any session activity is never evicted, so a server started once would live as long as the
// process does. Left idle this long, a server is stopped and the next use starts it again. The cap bounds a
// burst of distinct roots (one per language in a polyglot tree) that all stay warm.
const IDLE_TIME_TO_LIVE = "15 minutes"
const REAP_SWEEP_INTERVAL = "1 minute"
const MAX_CLIENTS = 8

/** The first failure restarts on next use; later ones wait 2s, 4s, ... up to 5 minutes. */
export function restartDelay(failures: number) {
  if (failures <= 1) return 0
  return Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * Math.pow(2, failures - 2))
}

type Item = {
  command?: readonly string[]
  extensions?: readonly string[]
  disabled?: boolean
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

/**
 * Documents apply from lowest to highest priority. A boolean resets everything before it; an object
 * merges each named server's supplied fields over the same name from earlier objects. Undefined when no
 * document mentions `lsp`, which leaves language servers off.
 */
const resolve = (entries: readonly Entry[]) =>
  entries.reduce<boolean | Record<string, Item> | undefined>((result, entry) => {
    if (entry.type !== "document" || entry.info.lsp === undefined) return result
    if (typeof entry.info.lsp === "boolean") return entry.info.lsp
    return Object.entries(entry.info.lsp).reduce<Record<string, Item>>(
      (merged, [name, item]) => ({
        ...merged,
        [name]: { ...merged[name], ...item, env: { ...merged[name]?.env, ...("env" in item ? item.env : undefined) } },
      }),
      typeof result === "object" ? result : {},
    )
  }, undefined)

const serversFor = (
  configured: boolean | Record<string, Item> | undefined,
  flags: LSPServer.Flags,
  available: readonly LSPServer.Info[],
) => {
  const servers = new Map<string, LSPServer.Info>()
  if (!configured) return servers
  available.forEach((server) => servers.set(server.id, server))
  servers.delete(flags.experimentalTy ? "pyright" : "ty")
  if (configured === true) return servers
  for (const [name, item] of Object.entries(configured)) {
    const existing = servers.get(name)
    if (item.disabled) {
      servers.delete(name)
      continue
    }
    const command = item.command
    if (!command || command.length === 0) continue
    // A configured command replaces how a server starts but keeps the built-in's root detection.
    servers.set(name, {
      id: name,
      extensions: item.extensions ?? existing?.extensions ?? [],
      root: existing?.root ?? ((_file, ctx) => Effect.succeed(ctx.directory)),
      spawn: (root) =>
        Effect.succeed(
          LSPServer.launch(root, command[0], command.slice(1), {
            env: item.env,
            initialization: item.initialization,
          }),
        ),
    })
  }
  return servers
}

export interface Options {
  readonly flags?: LSPServer.Flags
  /** The environment servers and tools are looked up in; the process environment by default. */
  readonly env?: NodeJS.ProcessEnv
  /** Replaces the built-in server list, for tests that need servers whose resolution they control. */
  readonly builtIns?: readonly LSPServer.Info[]
  /** How long a server may stay idle before it is stopped; the next use starts it again. */
  readonly idleTimeToLive?: Duration.Input
  /** How often the idle check runs. */
  readonly sweepInterval?: Duration.Input
  /** Most servers kept per location; above it the least recently used idle server is stopped. */
  readonly maxClients?: number
}

type Running = {
  readonly client: LSPClient.Info
  readonly scope: Scope.Closeable
  /** When `use` last touched the client and how many of its effects are in flight, for the idle sweep. */
  lastUsedAt: number
  inFlight: number
}

export const make = Effect.fn("LSP.make")(function* (options: Options = {}) {
  const location = yield* Location.Service
  const environment = yield* Environment.Service
  const config = yield* Config.Service
  const bus = yield* Bus.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const npm = yield* Npm.Service
  const processes = yield* AppProcess.Service
  const http = yield* HttpClient.HttpClient
  const scope = yield* Effect.scope
  const env = options.env ?? process.env
  const flags = options.flags ?? LSPServer.flagsFromEnv(env)
  const available = options.builtIns ?? builtIns
  const context = LSPServer.makeContext({
    directory: location.directory,
    worktree: location.project.directory,
    bin: global.bin,
    home: global.home,
    env,
    flags,
    fs,
    npm,
    processes,
    http,
  })
  const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })

  const state = {
    entries: undefined as readonly Entry[] | undefined,
    servers: new Map<string, LSPServer.Info>(),
    // Bumped when configuration changes so a server still starting under the old one is discarded.
    generation: 0,
    clients: [] as Running[],
    /** Servers that are permanently unavailable for a root (not installed, or crashed too often). */
    broken: new Set<string>(),
    /** Servers waiting out a restart backoff: key -> earliest retry time. */
    cooldown: new Map<string, number>(),
    failures: new Map<string, number>(),
    spawning: new Map<string, Deferred.Deferred<LSPClient.Info | undefined>>(),
  }

  const idleTimeToLive = Duration.toMillis(options.idleTimeToLive ?? IDLE_TIME_TO_LIVE)
  const sweepInterval = options.sweepInterval ?? REAP_SWEEP_INTERVAL
  const maxClients = options.maxClients ?? MAX_CLIENTS
  // Roots are canonicalized, so a displayed root is relative to the canonical location as well.
  const displayBase = FSUtil.resolve(location.directory)

  const inProject = (file: string) =>
    FSUtil.contains(location.directory, file) ||
    (location.project.directory !== path.parse(location.project.directory).root &&
      FSUtil.contains(location.project.directory, file))

  const reset = Effect.gen(function* () {
    state.generation++
    const stopped = state.clients.splice(0)
    state.broken.clear()
    state.cooldown.clear()
    state.failures.clear()
    yield* Effect.forEach(stopped, (running) => Scope.close(running.scope, Exit.void), { discard: true })
  })

  // Configuration is re-read on use; entries only change identity when it was reloaded.
  const servers = Effect.gen(function* () {
    const entries = yield* config.entries()
    if (state.entries === entries) return state.servers
    const reconfigured = state.entries !== undefined
    state.entries = entries
    const configured = resolve(entries)
    state.servers = serversFor(configured, flags, available)
    if (reconfigured) yield* reset
    if (!configured) yield* Effect.logInfo("all LSPs are disabled")
    else yield* Effect.logInfo("enabled LSP servers", { serverIds: [...state.servers.keys()].join(", ") })
    if (typeof configured === "object")
      yield* Effect.forEach(
        Object.entries(configured).filter(
          ([name, item]) => !item.disabled && item.command && !item.extensions && !available.some((server) => server.id === name),
        ),
        ([name]) =>
          Effect.logWarning("custom LSP entry has no extensions; it will attach to every file read", { "lsp.server": name }),
        { discard: true },
      )
    return state.servers
  })

  const fail = (key: string, startedAt: number) => {
    const now = Date.now()
    const failures = now - startedAt > RESTART_HEALTHY_UPTIME_MS ? 1 : (state.failures.get(key) ?? 0) + 1
    state.failures.set(key, failures)
    if (failures >= RESTART_MAX_FAILURES) {
      state.broken.add(key)
      state.cooldown.delete(key)
      return
    }
    state.cooldown.set(key, now + restartDelay(failures))
  }

  const schedule = Effect.fnUntraced(function* (server: LSPServer.Info, root: string, key: string) {
    const startedAt = Date.now()
    const generation = state.generation
    const handle = yield* server.spawn(root, context).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("failed to resolve LSP server", { serverID: server.id, cause }).pipe(Effect.as(undefined)),
      ),
    )
    if (!handle) {
      state.broken.add(key)
      return undefined
    }
    const clientScope = yield* Scope.fork(scope)
    const client = yield* LSPClient.create({ serverID: server.id, handle, root, directory: location.directory }).pipe(
      Effect.provideService(Environment.Service, environment),
      Scope.provide(clientScope),
      Effect.catchTag("LSP.InitializeError", (error) =>
        Effect.logWarning("failed to initialize LSP server", { serverID: server.id, root, error: error.message }).pipe(
          Effect.andThen(Effect.sync(() => fail(key, startedAt))),
          Effect.andThen(Scope.close(clientScope, Exit.void)),
          Effect.as(undefined),
        ),
      ),
    )
    if (!client) return undefined
    const existing = state.clients.find(
      (running) => running.client.root === root && running.client.serverID === server.id && running.client.alive(),
    )
    if (existing || generation !== state.generation) {
      yield* Scope.close(clientScope, Exit.void)
      // The caller is about to use it; stamp it like clientsFor does so a sweep cannot stop it first.
      if (existing) existing.lastUsedAt = Date.now()
      return existing?.client
    }
    const running: Running = { client, scope: clientScope, lastUsedAt: Date.now(), inFlight: 0 }
    state.clients.push(running)
    state.cooldown.delete(key)
    // A client whose process dies is dropped, so the next use respawns it.
    yield* Deferred.await(client.ended).pipe(
      Effect.flatMap((unexpected) =>
        Effect.gen(function* () {
          const index = state.clients.indexOf(running)
          if (!unexpected || index === -1) return
          state.clients.splice(index, 1)
          fail(key, startedAt)
          // Publish and log the crash before releasing the client scope: closing it kills the server's
          // process group (a taskkill spawn on Windows), and observers must not read a stale state in
          // that window. The close is cleanup, not part of the state transition observers wait for.
          yield* Effect.logWarning("LSP server exited", { serverID: server.id, root })
          yield* bus.publish(LspEvent.Updated, {}, { location: ref })
          yield* Scope.close(clientScope, Exit.void)
        }),
      ),
      Effect.forkIn(scope),
    )
    yield* bus.publish(LspEvent.Updated, {}, { location: ref })
    return client
  })

  const clientsFor = Effect.fnUntraced(function* (file: string) {
    if (!inProject(file)) return []
    const extension = path.parse(file).ext || file
    const matching = [...(yield* servers).values()].filter(
      (server) => server.extensions.length === 0 || server.extensions.includes(extension),
    )
    const resolved = yield* Effect.forEach(
      matching,
      Effect.fnUntraced(function* (server) {
        const found = yield* server.root(file, context)
        if (!found) return undefined
        // A symlinked alias and the directory it points at are one root: canonicalize before keying, or the
        // same server starts once per spelling of the same path.
        const root = FSUtil.resolve(found)
        const key = root + server.id
        if (state.broken.has(key)) return undefined
        const running = state.clients.find(
          (item) => item.client.root === root && item.client.serverID === server.id && item.client.alive(),
        )
        if (running) {
          // The caller is about to use this client; stamp it now so a sweep landing between the handout and
          // the request cannot stop it (use() then keeps it fresh for the duration).
          running.lastUsedAt = Date.now()
          return running.client
        }
        const retryAt = state.cooldown.get(key)
        if (retryAt !== undefined && Date.now() < retryAt) return undefined
        const inflight = state.spawning.get(key)
        if (inflight) return yield* Deferred.await(inflight)
        const task = yield* Deferred.make<LSPClient.Info | undefined>()
        state.spawning.set(key, task)
        // The start continues if the caller stops waiting (an edit gives up on slow servers), so the next use finds it ready.
        // The in-flight record goes first: a waiter resumes as soon as the deferred completes and may start again.
        yield* schedule(server, root, key).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => state.spawning.delete(key)).pipe(
              Effect.andThen(Deferred.succeed(task, Exit.isSuccess(exit) ? exit.value : undefined)),
            ),
          ),
          Effect.forkIn(scope),
        )
        return yield* Deferred.await(task)
      }),
      { concurrency: "unbounded" },
    )
    return resolved.filter((client): client is LSPClient.Info => client !== undefined)
  })

  /** Bumps a running client's idle clock; while the effect is in flight the sweep leaves it alone. */
  const use = <A>(client: LSPClient.Info, effect: Effect.Effect<A>) =>
    Effect.suspend(() => {
      const running = state.clients.find((item) => item.client === client)
      if (!running) return effect
      running.lastUsedAt = Date.now()
      running.inFlight++
      return effect.pipe(Effect.ensuring(Effect.sync(() => running.inFlight--)))
    })

  const each = <A>(file: string, f: (client: LSPClient.Info) => Effect.Effect<A>) =>
    clientsFor(file).pipe(
      Effect.flatMap((clients) =>
        Effect.forEach(clients, (client) => use(client, f(client)), { concurrency: "unbounded" }),
      ),
    )

  const everyRunning = <A>(f: (client: LSPClient.Info) => Effect.Effect<A>) =>
    Effect.suspend(() =>
      Effect.forEach(
        state.clients.filter((running) => running.client.alive()),
        (running) => use(running.client, f(running.client)),
        { concurrency: "unbounded" },
      ),
    )

  const at = (input: Position) => ({
    textDocument: { uri: pathToFileURL(input.file).href },
    position: { line: input.line, character: input.character },
  })

  const query = (method: string, extra?: Record<string, unknown>) => (input: Position) =>
    each(input.file, (client) =>
      client.request(method, { ...at(input), ...extra }).pipe(Effect.orElseSucceed(() => null)),
    )

  const present = (results: unknown[]) => results.flat().filter(Boolean)

  const callHierarchy = (direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls") => (input: Position) =>
    each(input.file, (client) =>
      Effect.gen(function* () {
        const items = yield* client.request("textDocument/prepareCallHierarchy", at(input)).pipe(Effect.orElseSucceed(() => null))
        if (!Array.isArray(items) || items.length === 0) return []
        return yield* client.request(direction, { item: items[0] }).pipe(Effect.orElseSucceed(() => []))
      }),
    ).pipe(Effect.map(present))

  const hover = query("textDocument/hover")
  const definition = query("textDocument/definition")
  const references = query("textDocument/references", { context: { includeDeclaration: true } })
  const implementation = query("textDocument/implementation")
  const prepare = query("textDocument/prepareCallHierarchy")

  // Servers idle past the TTL, and the least recently used ones above the cap, are stopped; a later use
  // starts them again. Stopping closes the client scope, the same path `reset` takes, so the exit observer
  // stays quiet and nothing is marked broken. A busy client is never stopped, so the cap is soft: it can be
  // exceeded while more than `maxClients` clients are all in use.
  const reap = Effect.gen(function* () {
    const now = Date.now()
    const victims = state.clients.filter(
      (running) => running.client.alive() && running.inFlight === 0 && now - running.lastUsedAt >= idleTimeToLive,
    )
    const over = state.clients.filter((running) => running.client.alive()).length - maxClients
    if (over > 0)
      victims.push(
        ...state.clients
          .filter((running) => running.client.alive() && running.inFlight === 0 && !victims.includes(running))
          .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)
          .slice(0, over),
      )
    if (victims.length === 0) return
    const reaped = new Set(victims)
    state.clients = state.clients.filter((running) => !reaped.has(running))
    yield* Effect.forEach(victims, (running) => Scope.close(running.scope, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    })
    yield* Effect.logInfo("LSP servers reaped", {
      servers: victims.map((running) => `${running.client.serverID}@${running.client.root}`).join(", "),
    })
    yield* bus.publish(LspEvent.Updated, {}, { location: ref })
  })
  yield* Effect.forever(Effect.sleep(sweepInterval).pipe(Effect.andThen(reap))).pipe(Effect.forkIn(scope))

  return Service.of({
    status: () =>
      Effect.sync(() =>
        state.clients.map(({ client }) => ({
          id: client.serverID,
          name: client.serverID,
          root: path.relative(displayBase, client.root),
          status: "connected" as const,
        })),
      ),
    hasClients: Effect.fn("LSP.hasClients")(function* (file: string) {
      if (!inProject(file)) return false
      const extension = path.parse(file).ext || file
      for (const server of (yield* servers).values()) {
        if (server.extensions.length && !server.extensions.includes(extension)) continue
        const found = yield* server.root(file, context)
        if (!found) continue
        if (state.broken.has(FSUtil.resolve(found) + server.id)) continue
        return true
      }
      return false
    }),
    touchFile: Effect.fn("LSP.touchFile")(function* (file: string, diagnostics?: LSPClient.WaitMode) {
      yield* Effect.logInfo("touching file", { file })
      const handled = yield* each(file, (client) =>
        Effect.gen(function* () {
          const after = Date.now()
          const version = yield* client.open(file)
          if (diagnostics) yield* client.waitForDiagnostics({ path: file, version, mode: diagnostics, after })
        }).pipe(Effect.ignore),
      )
      return handled.length
    }),
    diagnostics: Effect.fn("LSP.diagnostics")(function* () {
      const merged = new Map<string, LSPDiagnostic.Info[]>()
      // Servers start concurrently, so start order says nothing; configuration order keeps the merge stable.
      const order = [...state.servers.keys()]
      const running = state.clients
        .filter((item) => item.client.alive())
        .toSorted((a, b) => order.indexOf(a.client.serverID) - order.indexOf(b.client.serverID))
      for (const item of running)
        for (const [file, items] of item.client.diagnostics()) merged.set(file, [...(merged.get(file) ?? []), ...items])
      // Two servers claiming one file (a configured pyright-compatible entry next to the built-in one) report
      // the same finding under different `source` and `code`; each client only dedupes its own.
      return Object.fromEntries(
        [...merged].map(([file, items]) => {
          const seen = new Set<string>()
          return [
            file,
            items.filter((item) => {
              const key = LSPDiagnostic.identity(item)
              if (seen.has(key)) return false
              seen.add(key)
              return true
            }),
          ]
        }),
      )
    }),
    hover: (input) => hover(input).pipe(Effect.map(present)),
    definition: (input) => definition(input).pipe(Effect.map(present)),
    references: (input) => references(input).pipe(Effect.map(present)),
    implementation: (input) => implementation(input).pipe(Effect.map(present)),
    documentSymbol: (file) =>
      each(file, (client) =>
        client
          .request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } })
          .pipe(Effect.orElseSucceed(() => [])),
      ).pipe(Effect.map(present)),
    workspaceSymbol: (text) =>
      everyRunning((client) =>
        client.request("workspace/symbol", { query: text }).pipe(
          Effect.map((symbols) =>
            (Array.isArray(symbols) ? symbols : [])
              .filter((symbol) => Predicate.isObject(symbol) && typeof symbol.kind === "number" && WORKSPACE_SYMBOL_KINDS.includes(symbol.kind))
              .slice(0, WORKSPACE_SYMBOLS_PER_SERVER),
          ),
          Effect.orElseSucceed(() => []),
        ),
      ).pipe(Effect.map((results) => results.flat())),
    prepareCallHierarchy: (input) => prepare(input).pipe(Effect.map(present)),
    incomingCalls: callHierarchy("callHierarchy/incomingCalls"),
    outgoingCalls: callHierarchy("callHierarchy/outgoingCalls"),
  })
})

export const layer = (options?: Options) => Layer.effect(Service, make(options))
