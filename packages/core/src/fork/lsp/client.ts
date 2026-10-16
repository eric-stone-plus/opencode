export * as LSPClient from "./client.js"

import { Cause, Deferred, Effect, Option, Predicate, Queue, Result, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Bom } from "@opencode/util/bom"
import { FSUtil } from "@opencode/util/fs-util"
import { Environment } from "../../environment/index.js"
import { LSPDiagnostic } from "./diagnostic.js"
import { JsonRpc } from "./jsonrpc.js"
import { languageIdFor } from "./language.js"
import type { LSPServer } from "./server.js"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
const INITIALIZE_TIMEOUT_MS = 45_000
const STDERR_TAIL_BYTES = 2_000
// Upper bound for any request the runtime sends (hover, definition, symbols, ...): a hung server
// must not block a tool call forever.
export const REQUEST_TIMEOUT_MS = 30_000
// Servers keep every opened document in memory; the least recently touched ones are closed once a
// long-running session has opened more than this.
export const MAX_OPEN_DOCUMENTS = 200
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export class InitializeError extends Schema.TaggedError<InitializeError>()("LSP.InitializeError", {
  serverID: Schema.String,
  message: Schema.String,
}) {}

export type OpenError = Environment.NotFound | Environment.WrongKind | Environment.Failed

type Diagnostic = LSPDiagnostic.Info

const Items = Schema.Array(Schema.Unknown)
const DocumentReport = Schema.Struct({
  items: Schema.optionalKey(Items),
  relatedDocuments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ items: Schema.optionalKey(Items) }))),
})
const WorkspaceReport = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ uri: Schema.optionalKey(Schema.String), items: Schema.optionalKey(Items) }))),
})
const InitializeResult = Schema.Struct({
  capabilities: Schema.optionalKey(
    Schema.Struct({
      textDocumentSync: Schema.optionalKey(
        Schema.Union([Schema.Number, Schema.Struct({ change: Schema.optionalKey(Schema.Number) })]),
      ),
      diagnosticProvider: Schema.optionalKey(Schema.Unknown),
    }),
  ),
})
const Registration = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  registerOptions: Schema.optionalKey(
    Schema.Struct({
      identifier: Schema.optionalKey(Schema.String),
      workspaceDiagnostics: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})
const RegisterParams = Schema.Struct({ registrations: Schema.optionalKey(Schema.Array(Registration)) })
const UnregisterParams = Schema.Struct({
  unregisterations: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, method: Schema.String }))),
})
const PublishParams = Schema.Struct({
  uri: Schema.String,
  version: Schema.optionalKey(Schema.Number),
  diagnostics: Items,
})
const ConfigurationParams = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ section: Schema.optionalKey(Schema.String) }))),
})
const decodeInitialize = Schema.decodeUnknownOption(InitializeResult)
const decodeDocumentReport = Schema.decodeUnknownOption(DocumentReport)
const decodeWorkspaceReport = Schema.decodeUnknownOption(WorkspaceReport)
const decodeRegister = Schema.decodeUnknownOption(RegisterParams)
const decodeUnregister = Schema.decodeUnknownOption(UnregisterParams)
const decodePublish = Schema.decodeUnknownOption(PublishParams)
const decodeConfiguration = Schema.decodeUnknownOption(ConfigurationParams)

type PullResult = { handled: boolean; matched: boolean; byFile: Map<string, Diagnostic[]> }
const unhandled = (): PullResult => ({ handled: false, matched: false, byFile: new Map() })

function filePathOf(uri: string) {
  if (!uri.startsWith("file://")) return
  return Result.getOrUndefined(Result.try({ try: () => FSUtil.normalizePath(fileURLToPath(uri)), catch: () => undefined }))
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

function dedupe(items: ReadonlyArray<Diagnostic>) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify([item.code, LSPDiagnostic.identity(item), item.source])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// A server's `workspace/configuration` answer for a dotted section, served from its initialization options.
function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section
    .split(".")
    .reduce<unknown>((value, key) => (Predicate.isObject(value) && key in value ? value[key] : undefined), settings)
  return result ?? null
}

export interface Options {
  readonly serverID: string
  readonly handle: LSPServer.Handle
  readonly root: string
  readonly directory: string
}

export type WaitMode = "document" | "full"

export interface Info {
  readonly serverID: string
  readonly root: string
  readonly alive: () => boolean
  /**
   * Completes once the connection is over: true when the server exited or the connection broke on its own,
   * false when the client's Scope was closed on purpose.
   */
  readonly ended: Deferred.Deferred<boolean>
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, JsonRpc.RequestError>
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>
  /** Opens the document, or sends the current text of one that is already open. Resolves with its version. */
  readonly open: (file: string) => Effect.Effect<number, OpenError>
  readonly waitForDiagnostics: (input: {
    readonly path: string
    readonly version: number
    readonly mode?: WaitMode
    readonly after?: number
  }) => Effect.Effect<void>
  readonly diagnostics: () => Map<string, Diagnostic[]>
  readonly openDocuments: () => string[]
}

/**
 * Starts the server process in the current Scope and completes the initialize handshake. Closing the
 * Scope stops the process; the caller owns that Scope and is told about unexpected exits through `ended`.
 */
export const create = Effect.fn("LSPClient.create")(function* (options: Options) {
  const environment = yield* Environment.Service
  const serverID = options.serverID
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const ended = yield* Deferred.make<boolean>()
  const state = { dead: false, closing: false, stderr: "" }
  const scope = yield* Effect.scope
  const connection = JsonRpc.make({
    write: (frame) => Queue.offerUnsafe(outgoing, frame),
    label: serverID,
    onOverflow: (reason) => markDead(reason),
  })

  function markDead(reason = `LSP server ${serverID} is not running`) {
    if (state.dead) return
    state.dead = true
    connection.close(reason)
    Queue.endUnsafe(outgoing)
    Deferred.doneUnsafe(ended, Effect.succeed(!state.closing))
  }

  const handle = yield* environment.spawner
    .spawn(
      ChildProcess.make(options.handle.command, [...options.handle.args], {
        cwd: options.handle.cwd,
        env: options.handle.env,
        extendEnv: true,
        stdin: { stream: Stream.fromQueue(outgoing), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(Effect.mapError((error) => new InitializeError({ serverID, message: error.message })))
  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  // Files whose server has not published since the last didOpen/didChange: the first publish of a cycle
  // is the syntactic one for servers that push twice, and must not wake a wait (see the publish handler).
  const awaitingPublish = new Set<string>()
  // Monotonic id per pull batch: slower pulls from an earlier wait keep running after its wait returns,
  // and must not replace the answer a newer wait already wrote for the same file.
  let pullWaits = 0
  const pullWrittenBy = new Map<string, number>()
  const diagnosticRegistrations = new Map<string, typeof Registration.Type>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(file: string) => void>()
  // Insertion order doubles as LRU order: touching a document re-inserts it.
  const files = new Map<string, { version: number; text: string }>()
  const capabilities = { syncKind: undefined as number | undefined, staticPull: false, staticWorkspacePull: false }

  const mergedDiagnostics = (file: string) => dedupe([...(pushDiagnostics.get(file) ?? []), ...(pullDiagnostics.get(file) ?? [])])

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const publish = Option.getOrUndefined(decodePublish(params))
    const file = publish && filePathOf(publish.uri)
    if (!publish || !file) return
    published.set(file, { at: Date.now(), version: publish.version })
    const diagnostics = LSPDiagnostic.parse(publish.diagnostics)
    // TypeScript's server pushes syntactic findings first and semantic ones in a second publish, once per
    // document change. The first publish of a cycle is stored without waking waiters, so a wait only
    // completes on the publish that carries the semantic errors.
    const firstOfCycle = awaitingPublish.delete(file)
    pushDiagnostics.set(file, diagnostics)
    if (serverID === "typescript" && firstOfCycle) return
    for (const listener of diagnosticListeners) listener(file)
  })
  connection.onRequest("window/workDoneProgress/create", () => null)
  connection.onRequest("workspace/configuration", (params) =>
    (Option.getOrUndefined(decodeConfiguration(params))?.items ?? []).map((item) =>
      configurationValue(options.handle.initialization, item.section),
    ),
  )
  connection.onRequest("client/registerCapability", (params) => {
    const registrations = (Option.getOrUndefined(decodeRegister(params))?.registrations ?? []).filter(
      (registration) => registration.method === "textDocument/diagnostic",
    )
    registrations.forEach((registration) => diagnosticRegistrations.set(registration.id, registration))
    if (registrations.length > 0) for (const listener of [...registrationListeners]) listener()
    return null
  })
  connection.onRequest("client/unregisterCapability", (params) => {
    const unregistrations = (Option.getOrUndefined(decodeUnregister(params))?.unregisterations ?? []).filter(
      (registration) => registration.method === "textDocument/diagnostic",
    )
    unregistrations.forEach((registration) => diagnosticRegistrations.delete(registration.id))
    if (unregistrations.length > 0) for (const listener of [...registrationListeners]) listener()
    return null
  })
  connection.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: pathToFileURL(options.root).href }])
  connection.onRequest("workspace/diagnostic/refresh", () => null)

  yield* handle.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => connection.feed(chunk)).pipe(
        Effect.catchDefect((defect) => Effect.logWarning("LSP message handler failed", { serverID, defect })),
      ),
    ),
    Effect.ensuring(Effect.sync(() => markDead())),
    Effect.ignore,
    Effect.forkScoped,
  )
  yield* handle.exitCode.pipe(
    Effect.ignore,
    Effect.andThen(Effect.sync(() => markDead())),
    Effect.forkScoped,
  )
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.sync(() => (state.stderr = (state.stderr + text).slice(-STDERR_TAIL_BYTES)))),
    Effect.ignore,
    Effect.forkScoped,
  )
  // Finalizers run in reverse registration order: registered after the readers above, this runs before they
  // are interrupted, so a deliberate shutdown is not mistaken for a crash.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state.closing = true
      markDead()
    }),
  )

  const request: Info["request"] = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) =>
    connection.request(method, params, timeoutMs)
  const notify: Info["notify"] = (method, params) => Effect.sync(() => connection.notify(method, params))

  const initialized = yield* request(
    "initialize",
    {
      rootUri: pathToFileURL(options.root).href,
      processId: handle.pid,
      workspaceFolders: [{ name: "workspace", uri: pathToFileURL(options.root).href }],
      initializationOptions: { ...options.handle.initialization },
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
          publishDiagnostics: { versionSupport: false },
        },
      },
    },
    INITIALIZE_TIMEOUT_MS,
  ).pipe(
    Effect.mapError(
      (error) =>
        new InitializeError({
          serverID,
          message: state.stderr.trim() ? `${error.message}: ${state.stderr.trim()}` : error.message,
        }),
    ),
  )
  const advertised = Option.getOrUndefined(decodeInitialize(initialized))?.capabilities
  const sync = advertised?.textDocumentSync
  capabilities.syncKind = typeof sync === "number" ? sync : sync?.change
  capabilities.staticPull = Boolean(advertised?.diagnosticProvider)
  // A static provider that advertises `workspaceDiagnostics` also answers `workspace/diagnostic` without registration.
  const provider = advertised?.diagnosticProvider
  capabilities.staticWorkspacePull =
    Predicate.isObject(provider) && "workspaceDiagnostics" in provider && provider.workspaceDiagnostics === true
  connection.notify("initialized", {})
  if (options.handle.initialization) connection.notify("workspace/didChangeConfiguration", { settings: options.handle.initialization })

  const evictDocuments = Effect.gen(function* () {
    while (files.size > MAX_OPEN_DOCUMENTS) {
      const oldest = files.keys().next().value
      if (oldest === undefined) return
      files.delete(oldest)
      pushDiagnostics.delete(oldest)
      pullDiagnostics.delete(oldest)
      published.delete(oldest)
      awaitingPublish.delete(oldest)
      connection.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(oldest).href } })
    }
  })

  const open: Info["open"] = Effect.fn("LSPClient.open")(function* (file) {
    const target = FSUtil.normalizePath(path.isAbsolute(file) ? file : path.resolve(options.directory, file))
    const read = yield* environment.files.read(target)
    // Language servers copy every open document into memory and re-analyse it; a generated or minified file this
    // large costs more than its diagnostics are worth.
    if (read.info.size > MAX_DOCUMENT_BYTES)
      return yield* new Environment.Failed({ path: target, cause: new Error("document is too large for a language server") })
    const text = Bom.decodeBytes(read.bytes).text
    const uri = pathToFileURL(target).href
    const document = files.get(target)
    if (document !== undefined) {
      // Diagnostics are not cleared here: some servers (clangd) only republish when content actually changes,
      // so clearing would lose errors for a no-op touch. The server's next push or pull overwrites them.
      connection.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: FILE_CHANGE_CHANGED }] })
      const next = document.version + 1
      files.delete(target)
      files.set(target, { version: next, text })
      awaitingPublish.add(target)
      connection.notify("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges:
          capabilities.syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
            ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(document.text) }, text }]
            : [{ text }],
      })
      return next
    }
    connection.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: FILE_CHANGE_CREATED }] })
    pushDiagnostics.delete(target)
    pullDiagnostics.delete(target)
    awaitingPublish.add(target)
    connection.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdFor(target), version: 0, text },
    })
    files.set(target, { version: 0, text })
    yield* evictDocuments
    return 0
  })

  const mergeResults = (file: string, results: PullResult[], wait: number) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }
    const merged = new Map<string, Diagnostic[]>()
    for (const result of results)
      for (const [target, items] of result.byFile) merged.set(target, [...(merged.get(target) ?? []), ...items])
    if (matched && !merged.has(file)) merged.set(file, [])
    for (const [target, items] of merged) {
      if ((pullWrittenBy.get(target) ?? 0) > wait) continue
      pullWrittenBy.set(target, wait)
      pullDiagnostics.set(target, dedupe(items))
    }
    return { handled, matched }
  }

  const requestDiagnosticReport = Effect.fnUntraced(function* (file: string, identifier?: string) {
    const response = yield* request(
      "textDocument/diagnostic",
      { ...(identifier ? { identifier } : {}), textDocument: { uri: pathToFileURL(file).href } },
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).pipe(Effect.orElseSucceed(() => null))
    const report = Option.getOrUndefined(decodeDocumentReport(response))
    if (!report) return unhandled()
    const result = unhandled()
    const add = (target: string, items: ReadonlyArray<unknown>) =>
      result.byFile.set(target, [...(result.byFile.get(target) ?? []), ...LSPDiagnostic.parse(items)])
    if (report.items) {
      add(file, report.items)
      result.handled = true
      result.matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = filePathOf(uri)
      if (!relatedPath || !related.items) continue
      add(relatedPath, related.items)
      result.handled = true
      result.matched = result.matched || relatedPath === file
    }
    return result
  })

  const requestWorkspaceDiagnosticReport = Effect.fnUntraced(function* (file: string, identifier?: string) {
    const response = yield* request(
      "workspace/diagnostic",
      { ...(identifier ? { identifier } : {}), previousResultIds: [] },
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).pipe(Effect.orElseSucceed(() => null))
    const report = Option.getOrUndefined(decodeWorkspaceReport(response))
    if (!report) return unhandled()
    const result: PullResult = { handled: true, matched: false, byFile: new Map() }
    for (const item of report.items ?? []) {
      const target = item.uri ? filePathOf(item.uri) : undefined
      if (!target || !item.items) continue
      result.byFile.set(target, [...(result.byFile.get(target) ?? []), ...LSPDiagnostic.parse(item.items)])
      result.matched = result.matched || target === file
    }
    return result
  })

  const documentPullState = () => {
    const registrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      identifiers: [...new Set(registrations.flatMap((registration) => registration.registerOptions?.identifier ?? []))],
      supported: capabilities.staticPull || registrations.length > 0,
    }
  }

  const workspacePullState = () => {
    const registrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      identifiers: [...new Set(registrations.flatMap((registration) => registration.registerOptions?.identifier ?? []))],
      supported: capabilities.staticWorkspacePull || registrations.length > 0,
    }
  }

  // Latency-critical: the pulls run in parallel and the first batch that already holds diagnostics for the
  // current file ends the wait. Slower pulls keep merging in the background; never sequence them per
  // identifier and never add a settle delay after a match.
  const requestDocumentDiagnostics = Effect.fnUntraced(function* (file: string) {
    const wait = ++pullWaits
    const pulls = documentPullState()
    if (!pulls.supported) return { handled: false, matched: false }
    const requests = [requestDiagnosticReport(file), ...pulls.identifiers.map((identifier) => requestDiagnosticReport(file, identifier))]
    const results: PullResult[] = []
    const finished = yield* Deferred.make<{ handled: boolean; matched: boolean }>()
    let outstanding = requests.length
    // Every pull exits even when the client scope is closed under it (interrupted), so the wait must not
    // stay parked on a deferred no pull can complete.
    const settle = () => {
      outstanding--
      if (outstanding > 0) return
      Deferred.doneUnsafe(finished, Effect.succeed(mergeResults(file, results, wait)))
    }
    // Forked into the client's scope, not the wait's: the slower pulls keep merging after the wait returns.
    yield* Effect.forEach(
      requests,
      (pull) =>
        pull.pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              results.push(result)
              const merged = mergeResults(file, results, wait)
              const current = results.some((item) => (item.byFile.get(file)?.length ?? 0) > 0)
              if (current) Deferred.doneUnsafe(finished, Effect.succeed(merged))
            }),
          ),
          Effect.onExit(() => Effect.sync(settle)),
          Effect.forkIn(scope),
        ),
      { discard: true },
    )
    return yield* Deferred.await(finished)
  })

  const requestFullDiagnostics = Effect.fnUntraced(function* (file: string) {
    const wait = ++pullWaits
    const documents = documentPullState()
    const workspace = workspacePullState()
    if (!documents.supported && !workspace.supported) return { handled: false, matched: false }
    return mergeResults(
      file,
      yield* Effect.all(
        [
          ...(documents.supported ? [requestDiagnosticReport(file)] : []),
          ...documents.identifiers.map((identifier) => requestDiagnosticReport(file, identifier)),
          ...(workspace.supported ? [requestWorkspaceDiagnosticReport(file)] : []),
          ...workspace.identifiers.map((identifier) => requestWorkspaceDiagnosticReport(file, identifier)),
        ],
        { concurrency: "unbounded" },
      ),
      wait,
    )
  })

  const registrationChange = (timeout: number) =>
    timeout <= 0
      ? Effect.succeed(false)
      : Effect.callback<boolean>((resume) => {
          const finish = (changed: boolean) => {
            clearTimeout(timer)
            registrationListeners.delete(listener)
            resume(Effect.succeed(changed))
          }
          const listener = () => finish(true)
          registrationListeners.add(listener)
          const timer = setTimeout(() => finish(false), timeout)
          return Effect.sync(() => {
            clearTimeout(timer)
            registrationListeners.delete(listener)
          })
        })

  // Settles true once a publish that counts as fresh for this request has been quiet for the debounce
  // window, false when the timeout wins. A publish counts when its version matches, or when no version is
  // reported and it arrived after the request started.
  const freshPush = Effect.fnUntraced(function* (request: { path: string; version: number; after: number; timeout: number }) {
    const settled = yield* Deferred.make<boolean>()
    const timers: { debounce?: ReturnType<typeof setTimeout>; timeout?: ReturnType<typeof setTimeout> } = {}
    const finish = (value: boolean) => Deferred.doneUnsafe(settled, Effect.succeed(value))
    const check = () => {
      const hit = published.get(request.path)
      if (!hit) return
      if (typeof hit.version === "number" && hit.version !== request.version) return
      if (hit.at < request.after && hit.version !== request.version) return
      clearTimeout(timers.debounce)
      timers.debounce = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
    }
    const listener = (file: string) => {
      if (file === request.path) check()
    }
    timers.timeout = setTimeout(() => finish(false), request.timeout)
    diagnosticListeners.add(listener)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimeout(timers.debounce)
        clearTimeout(timers.timeout)
        diagnosticListeners.delete(listener)
      }),
    )
    check()
    return Deferred.await(settled)
  })

  const waitFor = (
    input: { path: string; version: number; after?: number },
    timeout: number,
    pull: (file: string) => Effect.Effect<{ handled: boolean; matched: boolean }>,
    done: (result: { handled: boolean; matched: boolean }) => boolean,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = input.after ?? Date.now()
        const push = yield* freshPush({ path: input.path, version: input.version, after: startedAt, timeout })
        while (Date.now() - startedAt < timeout) {
          if (done(yield* pull(input.path))) return
          const remaining = timeout - (Date.now() - startedAt)
          if (remaining <= 0) return
          const next = yield* Effect.raceFirst(
            push.pipe(Effect.map((ready) => (ready ? ("push" as const) : ("timeout" as const)))),
            registrationChange(remaining).pipe(Effect.map((changed) => (changed ? ("registration" as const) : ("timeout" as const)))),
          )
          // Only a new pull registration can make another pull worthwhile.
          if (next !== "registration") return
        }
      }),
    )

  const waitForDiagnostics: Info["waitForDiagnostics"] = (input) => {
    const target = FSUtil.normalizePath(path.isAbsolute(input.path) ? input.path : path.resolve(options.directory, input.path))
    const request = { path: target, version: input.version, after: input.after }
    if (input.mode === "document")
      return waitFor(request, DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS, requestDocumentDiagnostics, (result) => result.matched)
    return waitFor(request, DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS, requestFullDiagnostics, (result) => result.handled || result.matched)
  }

  const info: Info = {
    serverID,
    root: options.root,
    alive: () => !state.dead,
    ended,
    request,
    notify,
    open,
    waitForDiagnostics,
    diagnostics: () =>
      new Map([...new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])].map((file) => [file, mergedDiagnostics(file)])),
    openDocuments: () => [...files.keys()],
  }
  return info
})
