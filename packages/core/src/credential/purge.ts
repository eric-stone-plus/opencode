export * as CredentialPurge from "./purge.js"

import { randomBytes } from "node:crypto"
import { chmod, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/process"
import { supportsTuningPragmas } from "#sqlite"
import { PurgeInput, PurgeResult } from "@opencode/schema/credential"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Credential } from "../credential.js"
import { Database } from "../database/database.js"
import { ToolOutput } from "../tool-output.js"

// Secret values reach this module as plain strings, so nothing here may log, return, or throw one. A statement that
// carries a secret as a bound parameter fails with an error that quotes its parameters, and spans and logs would
// carry that error out. Failures are therefore reduced to a short code by `reason`, before any span ends, and the
// functions that handle secrets are untraced.

const MARK = "[redacted-key]"
// A shorter value would match unrelated text, so it is never searched for.
const MIN_SECRET_LENGTH = 12
const SCAN_CHUNK = 8 * 1024 * 1024
const ROWS_PER_UPDATE = 500
const ARTIFACT_LIMIT = 256 * 1024 * 1024

export class Failure extends Schema.TaggedError<Failure>()("CredentialPurge.Failure", { code: Schema.String }) {}

export interface Interface {
  /**
   * Removes the stored credentials of the selected integrations and sweeps other copies of their secret values.
   * With `dryRun` it only reports. The result lists counts and locations, never a value.
   */
  readonly run: (input: PurgeInput) => Effect.Effect<PurgeResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CredentialPurge") {}

type Location = PurgeResult["swept"][number]
type Db = Database.Interface["db"]
type Executor = Pick<Db, "all" | "run">
type Target = { readonly all: boolean; readonly ids: ReadonlySet<string> }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const db = (yield* Database.Service).db
    const global = yield* Global.Service
    const processes = yield* AppProcess.Service
    const mutex = yield* Semaphore.make(1)
    const places = placesOf(global)

    const run = Effect.fn("CredentialPurge.run")(
      function* (input: PurgeInput) {
        const preview = input.dryRun === true
        const compact = input.compact === true
        const history = input.history === true || compact
        const target: Target = {
          all: input.all === true,
          ids: new Set((input.integrationIDs ?? []).map(trimSlashes)),
        }
        const selected = (integrationID: string) => target.all || target.ids.has(trimSlashes(integrationID))

        const stored = yield* credentials.all()
        const removing = stored.filter((credential) => selected(credential.integrationID))
        const legacy = (yield* Effect.promise(() => readLegacy(places.auth))).filter(([id]) => selected(id))
        const found = collect(
          removing.flatMap((credential) => secretsOf(credential.value)),
          legacy.flatMap(([, entry]) => legacySecrets(entry)),
          stored.filter((credential) => !selected(credential.integrationID)).flatMap((credential) => secretsOf(credential.value)),
        )
        const sweepFiles = input.files === true
        const sweepHistory = history && found.needles.length > 0

        // The removed row itself holds the secret, so its pages are zeroed even when history is left alone.
        const outcome = yield* secureDelete(db, !preview)(
          Effect.gen(function* () {
            const removed = yield* Effect.forEach(
              removing,
              (credential) =>
                preview ? Effect.succeed({ credential, removed: false }) : removeCredential(credentials, credential),
              { concurrency: 1 },
            )
            const swept = [
              ...(sweepFiles ? yield* filesOf(processes, places, target, found, !preview) : []),
              ...(sweepHistory ? yield* historyOf(db, places, found.needles, !preview) : []),
            ]
            if (preview) return { removed, swept, remaining: [], compacted: undefined }

            const file = found.needles.length > 0 ? yield* databaseFile(db) : ""
            if (file !== "") yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.mapError(sanitize), Effect.ignore)
            const copies = file === "" ? undefined : yield* rawCopies(places, file, found.needles)
            const compacted = compact ? yield* compactDatabase(db, file, found.needles, copies) : undefined
            const database = compacted?.status === "done" ? yield* rawCopies(places, file, found.needles) : copies
            // The verification looks everywhere the sweeps can reach, whichever of them were requested, so what
            // is reported is what a reader of those places would find.
            const remaining = [
              ...(yield* filesOf(processes, places, target, found, false)),
              ...(yield* artifactsOf(places, found.needles, false)),
              ...(database === undefined ? [] : [database]),
            ].filter(reported)
            return { removed, swept, remaining, compacted }
          }),
        )

        const result: PurgeResult = {
          dryRun: preview,
          credentials: outcome.removed.map((item) => ({
            id: item.credential.id,
            integrationID: item.credential.integrationID,
            label: item.credential.label,
            removed: item.removed,
          })),
          secrets: found.counts,
          swept: outcome.swept,
          remaining: outcome.remaining,
          ...(compact ? { compact: outcome.compacted ?? { status: "skipped" as const, reason: "dry run" } } : {}),
        }
        yield* Effect.logInfo("credential purge", {
          dryRun: preview,
          integrations: target.all ? "all" : [...target.ids],
          credentials: result.credentials.length,
          removed: result.credentials.filter((item) => item.removed).length,
          swept: result.swept.length,
          remaining: result.remaining.length,
        })
        return result
      },
      // Whatever escapes is reduced to a code inside the span: the cause of a failed statement can quote its secrets.
      (effect) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.die(sanitize(Cause.squash(cause))),
          ),
        ),
    )

    return Service.of({ run: (input) => mutex.withPermits(1)(run(input)) })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Credential.node, Database.node, Global.node, AppProcess.node],
})

function placesOf(global: Global.Interface) {
  const display = (file: string) =>
    file === global.home || file.startsWith(global.home + path.sep) ? "~" + file.slice(global.home.length) : file
  return {
    display,
    auth: path.join(global.data, "auth.json"),
    env: path.join(global.config, "env"),
    // The service's settings, `service.json` and per-channel variants, live beside the seed file.
    settings: global.config,
    environmentDirectories: [
      ...new Set([path.join(path.dirname(global.config), "environment.d"), path.join(global.home, ".config", "environment.d")]),
    ],
    artifacts: [
      { kind: "tool-output" as const, directory: path.join(global.data, ToolOutput.DIRECTORY) },
      { kind: "log" as const, directory: global.log },
    ],
  }
}

type Places = ReturnType<typeof placesOf>

function secretsOf(value: Credential.Value) {
  if (value.type === "key") return [value.key]
  if (value.type === "oauth") return [value.refresh, value.access]
  return []
}

const LegacyEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("api"), key: Schema.String }),
  Schema.Struct({ type: Schema.Literal("oauth"), refresh: Schema.String, access: Schema.String }),
  Schema.Struct({ type: Schema.Literal("wellknown"), token: Schema.String }),
])
const decodeLegacy = Schema.decodeUnknownOption(LegacyEntry)
const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

function legacySecrets(entry: unknown) {
  const decoded = Option.getOrUndefined(decodeLegacy(entry))
  if (decoded === undefined) return []
  if (decoded.type === "api") return [decoded.key]
  if (decoded.type === "oauth") return [decoded.refresh, decoded.access]
  return [decoded.token]
}

// A value a credential outside the purge still holds is left alone: removing it would break that credential.
function collect(removed: readonly string[], legacy: readonly string[], kept: readonly string[]) {
  const candidates = new Set([...removed, ...legacy])
  const searchable = [...candidates].filter((value) => value.length >= MIN_SECRET_LENGTH)
  const secrets = searchable.filter((value) => !kept.includes(value))
  return {
    secrets,
    // History stores values JSON-escaped, so a value that needs escaping is searched for in both forms.
    needles: [...new Set(secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))],
    counts: {
      distinct: secrets.length,
      shared: searchable.length - secrets.length,
      short: candidates.size - searchable.length,
    },
  }
}

type Found = ReturnType<typeof collect>

// The migration that imports auth.json keys entries by integration ID with trailing slashes removed.
function trimSlashes(id: string) {
  return id.replace(/\/+$/, "")
}

function reported(item: Location) {
  return item.count > 0 || item.error !== undefined
}

function removeCredential(credentials: Credential.Interface, credential: Credential.Info) {
  return credentials.remove(credential.id).pipe(
    Effect.as({ credential, removed: true }),
    Effect.catchCause((cause) =>
      Effect.logWarning("credential purge removal failed", {
        credentialID: credential.id,
        integrationID: credential.integrationID,
        reason: reason(Cause.squash(cause)),
      }).pipe(Effect.as({ credential, removed: false })),
    ),
  )
}

// Failures are isolated per location and reported by code, so one unreadable file never hides the rest.
function attempt(kind: Location["kind"], location: string, work: () => Promise<number>) {
  return Effect.tryPromise({ try: work, catch: reason }).pipe(
    Effect.map((count): Location => ({ kind, location, count })),
    Effect.catch((error) => Effect.succeed<Location>({ kind, location, count: 0, error })),
    Effect.tap((result) =>
      result.error === undefined
        ? Effect.void
        : Effect.logWarning("credential purge location failed", { kind, location, reason: result.error }),
    ),
  )
}

const filesOf = Effect.fnUntraced(function* (
  processes: AppProcess.Interface,
  places: Places,
  target: Target,
  found: Found,
  write: boolean,
) {
  const { needles } = found
  const swept = yield* Effect.all(
    [
      attempt("auth", places.display(places.auth), () => sweepAuth(places.auth, target, needles, write)),
      ...(needles.length === 0
        ? []
        : [
            attempt("env", places.display(places.env), () => sweepLines(places.env, needles, write)),
            ...places.environmentDirectories.map((directory) =>
              sweepEach("environment.d", places, directory, (name) => name.endsWith(".conf"), (file) =>
                sweepLines(file, needles, write),
              ),
            ),
            sweepEach("service", places, places.settings, (name) => /^service(?:-.*)?\.json$/.test(name), (file) =>
              sweepSettings(file, needles, write),
            ),
            sweepSystemd(processes, needles, write),
          ]),
    ],
    { concurrency: 1 },
  )
  // The server resolves environment connections from its own variables, so a copy there keeps the integration live.
  const own = Object.entries(process.env).flatMap(([name, value]) =>
    value !== undefined && found.secrets.includes(value) ? [name] : [],
  )
  if (write) own.forEach((name) => delete process.env[name])
  return [...swept.flat(), ...own.map((name): Location => ({ kind: "process", location: name, count: 1 }))].filter(
    reported,
  )
})

// Sweeps each matching file of a directory as its own location; an unreadable directory is one failed location.
function sweepEach(
  kind: Location["kind"],
  places: Places,
  directory: string,
  accept: (name: string) => boolean,
  sweep: (file: string) => Promise<number>,
) {
  return Effect.tryPromise({ try: () => list(directory, accept), catch: reason }).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (name) => attempt(kind, places.display(path.join(directory, name)), () => sweep(path.join(directory, name))),
        { concurrency: 1 },
      ),
    ),
    Effect.catch((error) => Effect.succeed<Location[]>([{ kind, location: places.display(directory), count: 0, error }])),
  )
}

// The user manager hands its variables to every program it starts, so a copy there outlives the files it came from.
const sweepSystemd = Effect.fnUntraced(function* (processes: AppProcess.Interface, needles: readonly string[], write: boolean) {
  if (process.platform !== "linux") return []
  const systemctl = (args: readonly string[]) =>
    processes.run(ChildProcess.make("systemctl", ["--user", ...args], { extendEnv: true, stdin: "ignore" }), {
      timeout: "5 seconds",
      maxOutputBytes: 1024 * 1024,
      maxErrorBytes: 64 * 1024,
    })
  const listing = yield* systemctl(["show-environment"]).pipe(Effect.option)
  if (Option.isNone(listing) || listing.value.exitCode !== 0) return []
  const names = listing.value.stdout
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const at = line.indexOf("=")
      const name = line.slice(0, at)
      if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return []
      return needles.some((needle) => line.slice(at + 1).includes(needle)) ? [name] : []
    })
  if (write) yield* Effect.forEach(names, (name) => systemctl(["unset-environment", name]).pipe(Effect.ignore))
  return names.map((name): Location => ({ kind: "systemd", location: name, count: 1 }))
})

const artifactsOf = (places: Places, needles: readonly string[], write: boolean) =>
  Effect.all(
    places.artifacts.map((item) =>
      attempt(item.kind, places.display(item.directory), () => sweepDirectory(item.directory, needles, write)),
    ),
    { concurrency: 1 },
  ).pipe(Effect.map((items) => items.filter(reported)))

const historyOf = Effect.fnUntraced(function* (db: Db, places: Places, needles: readonly string[], write: boolean) {
  const rows = yield* redactDatabase(db, needles, write).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed<Location[]>([{ kind: "database", location: "history", count: 0, error: reason(Cause.squash(cause)) }]),
    ),
  )
  return [...rows, ...(yield* artifactsOf(places, needles, write))]
})

// Secure delete makes SQLite zero what it frees, so a removed row leaves no readable copy behind in the file.
// The connection is shared with the server, so the setting is put back afterwards.
function secureDelete(db: Db, enabled: boolean) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    enabled && supportsTuningPragmas
      ? Effect.acquireUseRelease(
          db.get<{ secure_delete: number }>(sql`PRAGMA secure_delete`).pipe(
            Effect.tap(() => db.run(sql`PRAGMA secure_delete = ON`)),
            Effect.mapError(sanitize),
            Effect.orDie,
          ),
          () => effect,
          (previous) =>
            db.run(sql.raw(`PRAGMA secure_delete = ${Number(previous?.secure_delete ?? 0)}`)).pipe(
              Effect.mapError(sanitize),
              Effect.orDie,
            ),
        )
      : effect
}

const databaseFile = (db: Db) =>
  db.get<{ file: string }>(sql`SELECT file FROM pragma_database_list WHERE name = 'main'`).pipe(
    Effect.map((row) => row?.file ?? ""),
    Effect.mapError(sanitize),
    Effect.orDie,
  )

const redactColumn = Effect.fnUntraced(function* (
  executor: Executor,
  target: { readonly table: string; readonly column: string },
  needles: readonly string[],
  write: boolean,
) {
  const table = sql.identifier(target.table)
  const column = sql.identifier(target.column)
  const matching = sql.join(
    needles.map((needle) => sql`instr(${column}, ${needle}) > 0`),
    sql` OR `,
  )
  const before = yield* executor.all<{ rid: number; ok: number | null }>(
    sql`SELECT rowid AS rid, json_valid(${column}) AS ok FROM ${table} WHERE ${matching}`,
  )
  if (!write || before.length === 0) return before.length
  const replaced = needles.reduce((expression, needle) => sql`replace(${expression}, ${needle}, ${MARK})`, sql`${column}`)
  const batches = Array.from({ length: Math.ceil(before.length / ROWS_PER_UPDATE) }, (_, index) =>
    sql.join(
      before.slice(index * ROWS_PER_UPDATE, (index + 1) * ROWS_PER_UPDATE).map((row) => sql`${row.rid}`),
      sql`, `,
    ),
  )
  yield* Effect.forEach(batches, (rows) => executor.run(sql`UPDATE ${table} SET ${column} = ${replaced} WHERE rowid IN (${rows})`))
  const valid = new Set(before.filter((row) => row.ok === 1).map((row) => row.rid))
  const after = (yield* Effect.forEach(batches, (rows) =>
    executor.all<{ rid: number; ok: number | null }>(
      sql`SELECT rowid AS rid, json_valid(${column}) AS ok FROM ${table} WHERE rowid IN (${rows})`,
    ),
  )).flat()
  // A redaction that breaks JSON that parsed before would corrupt history, so the column is left as it was.
  if (after.some((row) => valid.has(row.rid) && row.ok !== 1)) return yield* new Failure({ code: "JSON_INVALID" })
  return before.length
})

// Every text column of every table is searched, so history in tables added later is covered without a list.
const redactDatabase = Effect.fnUntraced(function* (db: Db, needles: readonly string[], write: boolean) {
  const tables = yield* db.all<{ name: string; sql: string | null }>(
    sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  )
  const targets = (yield* Effect.forEach(tables, (table) =>
    db
      .all<{ name: string; type: string; pk: number; hidden: number }>(
        sql`SELECT name, type, pk, hidden FROM pragma_table_xinfo(${table.name})`,
      )
      .pipe(
        Effect.map((columns) =>
          columns
            .filter((column) => column.hidden === 0 && column.pk === 0 && /char|text|clob|json|blob|^$/i.test(column.type))
            .map((column) => ({
              table: table.name,
              column: column.name,
              // `rowid` addresses the rows a redaction rewrites.
              rowid: !/without\s+rowid/i.test(table.sql ?? ""),
            })),
        ),
      ),
  )).flat()
  const where = (item: (typeof targets)[number]) => `${item.table}.${item.column}`
  const failed = (item: (typeof targets)[number], error: unknown): Location => ({
    kind: "database",
    location: where(item),
    count: 0,
    error: reason(error),
  })
  const column = (item: (typeof targets)[number], executor: Executor) =>
    redactColumn(executor, item, needles, write).pipe(
      Effect.map((count): Location => ({ kind: "database", location: where(item), count })),
    )
  const results = write
    ? // One transaction keeps the redaction atomic; a savepoint per column lets one failing column leave the others done.
      yield* db.transaction((tx) =>
        Effect.forEach(
          targets,
          (item) =>
            item.rowid
              ? tx.transaction((inner) => column(item, inner)).pipe(
                  Effect.mapError(sanitize),
                  Effect.catch((error) => Effect.succeed(failed(item, error))),
                )
              : Effect.succeed(failed(item, new Failure({ code: "WITHOUT_ROWID" }))),
          { concurrency: 1 },
        ),
      )
    : yield* Effect.forEach(
        targets,
        (item) =>
          item.rowid
            ? column(item, db).pipe(Effect.mapError(sanitize), Effect.catch((error) => Effect.succeed(failed(item, error))))
            : Effect.succeed(failed(item, new Failure({ code: "WITHOUT_ROWID" }))),
        { concurrency: 1 },
      )
  return results.filter(reported)
})

// Counts the copies the file still holds. Redacted rows hold none, so what remains sits in free pages.
function rawCopies(places: Places, file: string, needles: readonly string[]) {
  return attempt("database", `${places.display(file)} (file)`, async () =>
    (await Promise.all([file, `${file}-wal`, `${file}-shm`].map((target) => countRaw(target, needles)))).reduce(
      (sum, count) => sum + count,
      0,
    ),
  )
}

// A rewrite blocks the server's database for as long as it takes and needs free space for a second copy, so it only
// runs when the verification found copies a redaction cannot reach.
const compactDatabase = Effect.fnUntraced(function* (
  db: Db,
  file: string,
  needles: readonly string[],
  copies: Location | undefined,
) {
  if (needles.length === 0) return { status: "skipped" as const, reason: "no searchable values" }
  if (file === "") return { status: "skipped" as const, reason: "in-memory database" }
  if (copies === undefined || copies.count === 0) return { status: "skipped" as const, reason: "no copies remain" }
  const exit = yield* db.run(sql`VACUUM`).pipe(
    Effect.andThen(db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)),
    Effect.mapError(sanitize),
    Effect.exit,
  )
  if (exit._tag === "Success") return { status: "done" as const }
  return { status: "failed" as const, reason: reason(Cause.squash(exit.cause)) }
})

// A code that says what went wrong without quoting anything: file and SQL errors can repeat the content they touched.
function reason(error: unknown, depth = 0): string {
  if (typeof error !== "object" || error === null || depth > 5) return "UNKNOWN"
  if (Cause.isCause(error)) return reason(Cause.squash(error), depth + 1)
  if ("code" in error && typeof error.code === "string") return error.code
  if ("reason" in error) return reason(error.reason, depth + 1)
  if ("cause" in error && error.cause !== undefined) return reason(error.cause, depth + 1)
  if ("_tag" in error && typeof error._tag === "string") return error._tag
  return error instanceof Error ? error.name : "UNKNOWN"
}

function sanitize(error: unknown) {
  return new Failure({ code: reason(error) })
}

function holds(value: unknown, needles: readonly string[]): boolean {
  if (typeof value === "string") return needles.some((needle) => value.includes(needle))
  if (Array.isArray(value)) return value.some((item) => holds(item, needles))
  if (typeof value === "object" && value !== null) return Object.values(value).some((item) => holds(item, needles))
  return false
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function readText(file: string) {
  return readFile(file, "utf8").catch((error: unknown) => {
    if (missing(error)) return undefined
    throw error
  })
}

async function list(directory: string, accept: (name: string) => boolean) {
  const names = await readdir(directory).catch((error: unknown) => {
    if (missing(error)) return []
    throw error
  })
  return names.filter(accept).toSorted()
}

// The files hold other secrets too, so the replacement is private from its first byte and keeps the original's mode.
// It replaces the file the path leads to, so a symlinked dotfile stays a symlink.
async function replaceFile(file: string, content: string) {
  const target = await realpath(file)
  const { mode } = await stat(target)
  const temporary = `${target}.purge-${randomBytes(6).toString("hex")}`
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" })
    .then(() => chmod(temporary, mode & 0o777))
    .then(() => rename(temporary, target))
    .catch(async (error: unknown) => {
      await unlink(temporary).catch(() => undefined)
      throw error
    })
}

async function readLegacy(file: string) {
  const text = await readText(file).catch(() => undefined)
  const entries = text === undefined ? undefined : Option.getOrUndefined(decodeObject(text))
  return entries === undefined ? [] : Object.entries(entries)
}

async function sweepAuth(file: string, target: Target, needles: readonly string[], write: boolean) {
  const text = await readText(file)
  if (text === undefined) return 0
  const entries = Option.getOrUndefined(decodeObject(text))
  if (entries === undefined) throw new Failure({ code: "INVALID_JSON" })
  const kept = Object.entries(entries).filter(
    ([id, entry]) => !(target.all || target.ids.has(trimSlashes(id)) || holds(entry, needles)),
  )
  const removed = Object.keys(entries).length - kept.length
  if (removed > 0 && write)
    await replaceFile(file, JSON.stringify(Object.fromEntries(kept), null, 2) + (text.endsWith("\n") ? "\n" : ""))
  return removed
}

// Shell exports and systemd environment files are one assignment per line, so a line that holds the value goes.
async function sweepLines(file: string, needles: readonly string[], write: boolean) {
  const text = await readText(file)
  if (text === undefined) return 0
  const lines = text.split("\n")
  const kept = lines.filter((line) => !needles.some((needle) => line.includes(needle)))
  if (kept.length < lines.length && write) await replaceFile(file, kept.join("\n"))
  return lines.length - kept.length
}

// Environment variables pinned for the background service are stored in its settings file.
async function sweepSettings(file: string, needles: readonly string[], write: boolean) {
  const text = await readText(file)
  if (text === undefined) return 0
  const settings = Option.getOrUndefined(decodeObject(text))
  if (settings === undefined) throw new Failure({ code: "INVALID_JSON" })
  const environment = settings.env
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) return 0
  const kept = Object.entries(environment).filter(([, value]) => !holds(value, needles))
  const removed = Object.keys(environment).length - kept.length
  if (removed > 0 && write)
    await replaceFile(file, JSON.stringify({ ...settings, env: Object.fromEntries(kept) }, null, 2) + "\n")
  return removed
}

// Saved tool output and logs are opaque bytes. They are edited in place because other processes append to the logs.
async function sweepDirectory(directory: string, needles: readonly string[], write: boolean) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (missing(error)) return []
    throw error
  })
  const changed: string[] = []
  for (const entry of entries.filter((item) => item.isFile())) {
    const file = path.join(directory, entry.name)
    if ((await countRaw(file, needles)) === 0) continue
    if (write) await redactFile(file, needles)
    changed.push(file)
  }
  return changed.length
}

async function redactFile(file: string, needles: readonly string[]) {
  if ((await stat(file)).size > ARTIFACT_LIMIT) throw new Failure({ code: "TOO_LARGE" })
  // Latin-1 maps every byte to one character, so replacing in it never alters bytes outside the match.
  const bytes = Buffer.from(
    needles.reduce(
      (text, needle) => text.replaceAll(Buffer.from(needle).toString("latin1"), MARK),
      (await readFile(file)).toString("latin1"),
    ),
    "latin1",
  )
  const handle = await open(file, "r+")
  try {
    await handle.write(bytes, 0, bytes.length, 0)
    await handle.truncate(bytes.length)
  } finally {
    await handle.close()
  }
}

function* matches(buffer: Buffer, pattern: Buffer) {
  for (let at = buffer.indexOf(pattern); at >= 0; at = buffer.indexOf(pattern, at + 1)) yield at
}

// Counts occurrences straight from the bytes, so it also finds copies the database no longer references.
async function countRaw(file: string, needles: readonly string[]) {
  const patterns = needles.map((needle) => Buffer.from(needle))
  const overlap = Math.max(...patterns.map((pattern) => pattern.length)) - 1
  const handle = await open(file, "r").catch((error: unknown) => {
    if (missing(error)) return undefined
    throw error
  })
  if (handle === undefined) return 0
  const counts: number[] = []
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK + overlap)
    for (let position = 0; position < size; position += SCAN_CHUNK) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      const last = position + bytesRead >= size
      const view = buffer.subarray(0, bytesRead)
      // The overlap belongs to the next chunk, which counts the matches that start inside it.
      counts.push(
        patterns.reduce((sum, pattern) => sum + [...matches(view, pattern)].filter((at) => last || at < SCAN_CHUNK).length, 0),
      )
    }
  } finally {
    await handle.close()
  }
  return counts.reduce((sum, count) => sum + count, 0)
}
