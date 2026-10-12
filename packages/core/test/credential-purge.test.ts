import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Effect, Layer, Logger, References, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { CredentialPurge } from "@opencode/core/credential/purge"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { it } from "./lib/effect"
import { tmpdirScoped } from "./fixture/tmpdir"

// Obviously fake values: long enough to be searched for, and nothing like a real key.
const QWEN = "fake-qwen-key-aaaaaaaaaaaaaaaa"
const GLM = "fake-glm-key-bbbbbbbbbbbbbbbb"
const DEEPSEEK = "fake-deepseek-key-cccccccccccc"
const bailian = Integration.ID.make("bailian-token-plan-personal")
const glm = Integration.ID.make("glm-coding-plan")
const deepseek = Integration.ID.make("deepseek")
type Fixture = {
  readonly root: string
  readonly commands: string[][]
  // The user manager's variables; `unset-environment` removes from it like the real one.
  readonly manager: Map<string, string>
}

// Every path a purge touches is rooted in the temporary directory, and systemctl is a recording fake.
function layerFor(fixture: Fixture) {
  const { root } = fixture
  const output = (text: string) => Stream.make(Buffer.from(text))
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die(new Error("unexpected piped command"))
      fixture.commands.push([command.command, ...command.args])
      if (command.args[1] === "unset-environment") fixture.manager.delete(command.args[2])
      const stdout = output(
        command.args.includes("show-environment")
          ? [...fixture.manager].map(([name, value]) => `${name}=${value}`).join("\n") + "\n"
          : "",
      )
      return Effect.succeed(
        makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
  return AppNodeBuilder.build(LayerNode.group([CredentialPurge.node, Credential.node, Database.node, Bus.node]), [
    Global.node.replace(
      Global.layerWith({
        home: root,
        data: path.join(root, "data"),
        config: path.join(root, ".config", "opencode"),
        state: path.join(root, "state"),
        cache: path.join(root, "cache"),
        tmp: path.join(root, "tmp"),
        bin: path.join(root, "cache", "bin"),
        log: path.join(root, "data", "log"),
        repos: path.join(root, "data", "repos"),
      }),
    ),
    Database.node.replace(Database.configured({ path: path.join(root, "data", "purge.db") })),
    CrossSpawnSpawner.node.replace(spawner),
  ])
}

const scenario = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, CredentialPurge.Service | Credential.Service | Database.Service>) =>
  () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const fixture: Fixture = {
        root: temporary.path,
        commands: [],
        manager: new Map([
          ["PATH", "/usr/bin"],
          ["OPENCODE_DB", "opencode-main.db"],
        ]),
      }
      return yield* body(fixture).pipe(Effect.provide(layerFor(fixture)))
    })

const file = (fixture: Fixture, ...segments: string[]) => path.join(fixture.root, ...segments)
const write = (target: string, content: string, mode = 0o600) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, { mode })
    await fs.chmod(target, mode)
  })
const read = (target: string) => Effect.promise(() => fs.readFile(target, "utf8"))
const modeOf = (target: string) => Effect.promise(async () => (await fs.stat(target)).mode & 0o777)

function key(integrationID: Integration.ID, value: string, label?: string) {
  return Effect.gen(function* () {
    const credentials = yield* Credential.Service
    return yield* credentials.create({ integrationID, label, value: Credential.Key.make({ type: "key", key: value }) })
  })
}

// Records every log message, annotation, and cause emitted while the purge runs.
function recorded<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const entries: unknown[] = []
  const logger = Logger.make<unknown, void>((options) => {
    entries.push({
      message: options.message,
      cause: Cause.isCause(options.cause) ? Cause.pretty(options.cause) : undefined,
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
    })
  })
  return effect.pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.map((value) => ({ value, entries })),
  )
}

const rawCopies = (fixture: Fixture, needle: string) =>
  Effect.promise(async () => {
    const files = ["purge.db", "purge.db-wal", "purge.db-shm"].map((name) => file(fixture, "data", name))
    const contents = await Promise.all(files.map((target) => fs.readFile(target).catch(() => Buffer.alloc(0))))
    return contents.reduce((total, content) => total + content.toString("latin1").split(needle).length - 1, 0)
  })

const secureDelete = (db: Database.Interface["db"]) =>
  db.get<{ secure_delete: number }>(sql`PRAGMA secure_delete`).pipe(Effect.map((row) => row?.secure_delete))

describe("CredentialPurge", () => {
  it.live(
    "removes every credential of the selected integrations through the credential service",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const credentials = yield* Credential.Service
        fixture.manager.set("QWEN_PIN", QWEN)
        yield* key(glm, GLM, "Work")
        yield* key(glm, QWEN, "Personal")
        const kept = yield* key(deepseek, DEEPSEEK, "default")

        const { value: result, entries } = yield* recorded(purge.run({ integrationIDs: [glm] }))

        expect(result.dryRun).toBe(false)
        // The selected credential is removed last, so the integration switches once, to nothing.
        expect(result.credentials.map((item) => [item.integrationID, item.label, item.removed])).toEqual([
          [glm, "Work", true],
          [glm, "Personal", true],
        ])
        expect(yield* credentials.list(glm)).toEqual([])
        expect(yield* credentials.all()).toEqual([kept])
        expect(result.secrets).toEqual({ distinct: 2, shared: 0, short: 0 })
        expect(result.swept).toEqual([])
        // Places the run was not asked to clean are still looked at, so the report says what is left in them.
        expect(result.remaining).toEqual([{ kind: "systemd", location: "QWEN_PIN", count: 1 }])
        expect(fixture.commands).toEqual([["systemctl", "--user", "show-environment"]])
        expect(JSON.stringify({ result, entries })).not.toContain("fake-")
      }),
    ),
  )

  it.live(
    "sweeps stale copies of a removed value from credential files by value",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        fixture.manager.set("QWEN_PIN", QWEN)
        yield* key(bailian, QWEN)
        yield* key(glm, GLM)
        const authFile = file(fixture, "data", "auth.json")
        const envFile = file(fixture, ".config", "opencode", "env")
        const confFile = file(fixture, ".config", "environment.d", "95-qwen-provider.conf")
        const otherConf = file(fixture, ".config", "environment.d", "90-fcitx5.conf")
        const settingsFile = file(fixture, ".config", "opencode", "service.json")
        yield* write(
          authFile,
          JSON.stringify(
            {
              [bailian]: { type: "api", key: QWEN },
              "renamed-alias": { type: "api", key: QWEN },
              [glm]: { type: "api", key: GLM },
              [deepseek]: { type: "api", key: DEEPSEEK },
            },
            null,
            2,
          ) + "\n",
        )
        yield* write(
          envFile,
          [
            "# seed",
            `export QIANWEN_TP_PERSONAL_KEY=${QWEN}`,
            `export QUOTED="${QWEN}"`,
            "export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536",
            "",
          ].join("\n"),
        )
        yield* write(
          confFile,
          [`QIANWEN_TP_PERSONAL_KEY=${QWEN}`, "QIANWEN_TP_PERSONAL_BASE_URL=https://example.invalid/v1", ""].join("\n"),
          0o644,
        )
        yield* write(otherConf, "QT_IM_MODULE=fcitx\n", 0o644)
        yield* write(
          settingsFile,
          JSON.stringify({ password: "service-password-fake", env: { QWEN_PIN: QWEN, KEEP: "yes" } }, null, 2) + "\n",
        )

        const { value: result, entries } = yield* recorded(
          purge.run({ integrationIDs: [bailian], files: true }),
        )

        expect(JSON.parse(yield* read(authFile))).toEqual({
          [glm]: { type: "api", key: GLM },
          [deepseek]: { type: "api", key: DEEPSEEK },
        })
        expect((yield* read(authFile)).endsWith("}\n")).toBe(true)
        expect(yield* modeOf(authFile)).toBe(0o600)
        expect(yield* read(envFile)).toBe(
          ["# seed", "export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536", ""].join("\n"),
        )
        expect(yield* read(confFile)).toBe("QIANWEN_TP_PERSONAL_BASE_URL=https://example.invalid/v1\n")
        expect(yield* modeOf(confFile)).toBe(0o644)
        expect(yield* read(otherConf)).toBe("QT_IM_MODULE=fcitx\n")
        expect(JSON.parse(yield* read(settingsFile))).toEqual({ password: "service-password-fake", env: { KEEP: "yes" } })
        expect(result.swept).toEqual([
          { kind: "auth", location: "~/data/auth.json", count: 2 },
          { kind: "env", location: "~/.config/opencode/env", count: 2 },
          { kind: "environment.d", location: "~/.config/environment.d/95-qwen-provider.conf", count: 1 },
          { kind: "service", location: "~/.config/opencode/service.json", count: 1 },
          { kind: "systemd", location: "QWEN_PIN", count: 1 },
        ])
        expect(result.remaining).toEqual([])
        expect(fixture.commands).toEqual([
          ["systemctl", "--user", "show-environment"],
          ["systemctl", "--user", "unset-environment", "QWEN_PIN"],
          ["systemctl", "--user", "show-environment"],
        ])
        expect(JSON.stringify({ result, entries })).not.toContain("fake-")
      }),
    ),
  )

  it.live(
    "keeps a symlinked seed file a symlink and edits the file it points to",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        yield* key(bailian, QWEN)
        const real = file(fixture, "dotfiles", "env")
        const link = file(fixture, ".config", "opencode", "env")
        yield* write(real, `export QIANWEN_TP_PERSONAL_KEY=${QWEN}\nexport KEEP=1\n`)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(link), { recursive: true })
          await fs.symlink(real, link)
        })

        yield* purge.run({ integrationIDs: [bailian], files: true })

        expect((yield* Effect.promise(() => fs.lstat(link))).isSymbolicLink()).toBe(true)
        expect(yield* read(real)).toBe("export KEEP=1\n")
      }),
    ),
  )

  it.live(
    "previews a purge without changing credentials, files, environment, or history",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const credentials = yield* Credential.Service
        const db = (yield* Database.Service).db
        yield* key(bailian, QWEN)
        const authFile = file(fixture, "data", "auth.json")
        const envFile = file(fixture, ".config", "opencode", "env")
        const log = file(fixture, "data", "log", "opencode.log")
        yield* write(authFile, JSON.stringify({ [bailian]: { type: "api", key: QWEN } }, null, 2) + "\n")
        yield* write(envFile, `export QIANWEN_TP_PERSONAL_KEY=${QWEN}\n`)
        yield* write(log, `line with ${QWEN}\n`)
        yield* db.run(sql`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('probe', ${`{"k":"${QWEN}"}`}, 1, 1)`)
        const before = [yield* read(authFile), yield* read(envFile), yield* read(log)]
        const previous = yield* secureDelete(db)
        process.env.PURGE_TEST_PREVIEW = QWEN

        const result = yield* purge.run({ all: true, files: true, history: true, compact: true, dryRun: true }).pipe(
          Effect.ensuring(Effect.sync(() => delete process.env.PURGE_TEST_PREVIEW)),
        )

        expect(result.dryRun).toBe(true)
        expect(result.credentials.map((item) => item.removed)).toEqual([false])
        expect(result.remaining).toEqual([])
        expect(result.compact).toEqual({ status: "skipped", reason: "dry run" })
        expect(result.swept.map((item) => [item.kind, item.location, item.count])).toEqual(
          expect.arrayContaining([
            ["auth", "~/data/auth.json", 1],
            ["env", "~/.config/opencode/env", 1],
            ["process", "PURGE_TEST_PREVIEW", 1],
            ["database", "kv.value", 1],
            ["log", "~/data/log", 1],
          ]),
        )
        expect((yield* credentials.all()).length).toBe(1)
        expect([yield* read(authFile), yield* read(envFile), yield* read(log)]).toEqual(before)
        expect(
          (yield* db.get<{ value: string }>(sql`SELECT value FROM kv WHERE key = 'probe'`))?.value,
        ).toContain(QWEN)
        expect(yield* secureDelete(db)).toBe(previous)
        expect(fixture.commands.some((command) => command.includes("unset-environment"))).toBe(false)
      }),
    ),
  )

  it.live(
    "leaves a value another credential still holds, and values too short to search for",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const credentials = yield* Credential.Service
        yield* key(bailian, QWEN)
        yield* key(glm, QWEN)
        yield* key(glm, "short")
        const envFile = file(fixture, ".config", "opencode", "env")
        yield* write(envFile, [`export SHARED=${QWEN}`, "export TINY=short", ""].join("\n"))

        const result = yield* purge.run({ integrationIDs: [glm], files: true })

        expect(result.secrets).toEqual({ distinct: 0, shared: 1, short: 1 })
        expect(yield* read(envFile)).toBe([`export SHARED=${QWEN}`, "export TINY=short", ""].join("\n"))
        expect((yield* credentials.all()).map((item) => item.integrationID)).toEqual([bailian])
      }),
    ),
  )

  it.live(
    "unsets exact copies from the server environment and the user manager only",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        fixture.manager.set("QWEN_PIN", QWEN)
        yield* key(bailian, QWEN)

        const { result, exact, embedded } = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            process.env.PURGE_TEST_EXACT = QWEN
            process.env.PURGE_TEST_EMBEDDED = `Bearer ${QWEN}`
          }),
          () =>
            purge.run({ integrationIDs: [bailian], files: true }).pipe(
              Effect.map((result) => ({
                result,
                exact: process.env.PURGE_TEST_EXACT,
                embedded: process.env.PURGE_TEST_EMBEDDED,
              })),
            ),
          () =>
            Effect.sync(() => {
              delete process.env.PURGE_TEST_EMBEDDED
              delete process.env.PURGE_TEST_EXACT
            }),
        )

        expect(exact).toBeUndefined()
        expect(embedded).toBe(`Bearer ${QWEN}`)
        expect(result.swept.filter((item) => item.kind === "process" || item.kind === "systemd")).toEqual([
          { kind: "systemd", location: "QWEN_PIN", count: 1 },
          { kind: "process", location: "PURGE_TEST_EXACT", count: 1 },
        ])
        expect([...fixture.manager.keys()]).toEqual(["PATH", "OPENCODE_DB"])
        expect(fixture.commands).toContainEqual(["systemctl", "--user", "unset-environment", "QWEN_PIN"])
        expect(fixture.commands.flat()).not.toContain("OPENCODE_DB")
      }),
    ),
  )

  it.live(
    "reports a credential file it cannot parse without quoting it",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        yield* key(bailian, QWEN)
        const authFile = file(fixture, "data", "auth.json")
        yield* write(authFile, `{"${bailian}": {"key": "${QWEN}"`)

        const { value: result, entries } = yield* recorded(purge.run({ integrationIDs: [bailian], files: true }))

        expect(result.swept[0]).toEqual({ kind: "auth", location: "~/data/auth.json", count: 0, error: "INVALID_JSON" })
        expect(yield* read(authFile)).toContain(QWEN)
        expect(JSON.stringify({ result, entries })).not.toContain("fake-")
      }),
    ),
  )

  it.live(
    "redacts history in every text column with secure delete, and leaves no copy in the database file",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const db = (yield* Database.Service).db
        yield* key(bailian, QWEN)
        yield* db.run(sql`CREATE TABLE purge_probe (id INTEGER PRIMARY KEY, body TEXT, note TEXT, size INTEGER)`)
        const json = JSON.stringify({ output: `printed ${QWEN} here`, other: "untouched" })
        yield* db.run(sql`INSERT INTO purge_probe (body, note, size) VALUES (${json}, ${`plain ${QWEN}`}, 1)`)
        yield* db.run(sql`INSERT INTO purge_probe (body, note, size) VALUES (${'{"clean":true}'}, 'clean', 2)`)
        yield* db.run(sql`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('probe', ${json}, 1, 1)`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('agg', 1)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('evt1', 'agg', 1, 1, 'tool', ${json})`,
        )
        const toolOutput = file(fixture, "data", "tool-output", "tool_000000000001")
        const log = file(fixture, "data", "log", "opencode.log")
        yield* write(toolOutput, `head\n${QWEN}\ntail\n`)
        yield* write(log, `a ${QWEN} b\nuntouched\n`, 0o644)
        const previous = yield* secureDelete(db)

        const { value: result, entries } = yield* recorded(purge.run({ integrationIDs: [bailian], history: true }))

        expect(result.swept.map((item) => [item.kind, item.location, item.count])).toEqual([
          ["database", "event.data", 1],
          ["database", "kv.value", 1],
          ["database", "purge_probe.body", 1],
          ["database", "purge_probe.note", 1],
          ["tool-output", "~/data/tool-output", 1],
          ["log", "~/data/log", 1],
        ])
        expect(result.remaining).toEqual([])
        expect(result.compact).toBeUndefined()
        const body = (yield* db.all<{ body: string; note: string; size: number }>(
          sql`SELECT body, note, size FROM purge_probe ORDER BY id`,
        ))
        expect(body).toEqual([
          { body: json.replace(QWEN, "[redacted-key]"), note: "plain [redacted-key]", size: 1 },
          { body: '{"clean":true}', note: "clean", size: 2 },
        ])
        expect(JSON.parse(body[0].body).other).toBe("untouched")
        expect((yield* db.get<{ ok: number }>(sql`SELECT json_valid(value) AS ok FROM kv WHERE key = 'probe'`))?.ok).toBe(1)
        expect(yield* read(toolOutput)).toBe("head\n[redacted-key]\ntail\n")
        expect(yield* read(log)).toBe("a [redacted-key] b\nuntouched\n")
        expect(yield* modeOf(log)).toBe(0o644)
        expect(yield* secureDelete(db)).toBe(previous)
        expect(yield* rawCopies(fixture, QWEN)).toBe(0)
        expect(fixture.commands).toEqual([["systemctl", "--user", "show-environment"]])
        expect(JSON.stringify({ result, entries })).not.toContain("fake-")
      }),
    ),
  )

  it.live(
    "reports copies a deleted row left in the free pages and removes them only when asked to compact",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const db = (yield* Database.Service).db
        yield* db.run(sql`PRAGMA secure_delete = OFF`)
        yield* db.run(sql`CREATE TABLE purge_probe (id INTEGER PRIMARY KEY, body TEXT)`)
        // Several pages of text, so the value sits in overflow pages that deleting the row frees without zeroing.
        const large = `${"x".repeat(30_000)}${QWEN}${"y".repeat(30_000)}`
        yield* db.run(sql`INSERT INTO purge_probe (id, body) VALUES (1, ${large})`)
        yield* db.run(sql`DELETE FROM purge_probe WHERE id = 1`)
        yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
        yield* key(bailian, QWEN)
        expect(yield* rawCopies(fixture, QWEN)).toBeGreaterThan(0)

        const reported = yield* purge.run({ integrationIDs: [bailian], history: true })

        expect(reported.compact).toBeUndefined()
        expect(reported.remaining).toEqual([
          expect.objectContaining({ kind: "database", location: "~/data/purge.db (file)", count: expect.any(Number) }),
        ])
        expect(reported.remaining[0].count).toBeGreaterThan(0)
        expect(yield* rawCopies(fixture, QWEN)).toBeGreaterThan(0)

        yield* key(bailian, QWEN)
        const compacted = yield* purge.run({ integrationIDs: [bailian], compact: true })

        expect(compacted.compact).toEqual({ status: "done" })
        expect(compacted.remaining).toEqual([])
        expect(yield* rawCopies(fixture, QWEN)).toBe(0)
        expect((yield* db.all<{ ok: string }>(sql`PRAGMA quick_check`)).map((row) => Object.values(row)[0])).toEqual(["ok"])
      }),
    ),
  )

  it.live(
    "undoes a column whose redaction would break its JSON and still redacts the others",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const db = (yield* Database.Service).db
        // A bare number is the one place a marker string cannot stand in for the value.
        const numeric = "123456789012"
        yield* key(bailian, numeric)
        yield* db.run(sql`CREATE TABLE purge_probe (id INTEGER PRIMARY KEY, body TEXT, note TEXT)`)
        yield* db.run(sql`INSERT INTO purge_probe (body, note) VALUES (${`{"n":${numeric}}`}, ${`note ${numeric}`})`)

        const result = yield* purge.run({ integrationIDs: [bailian], history: true })

        expect(result.swept).toEqual([
          { kind: "database", location: "purge_probe.body", count: 0, error: "JSON_INVALID" },
          { kind: "database", location: "purge_probe.note", count: 1 },
        ])
        expect(
          yield* db.get<{ body: string; note: string }>(sql`SELECT body, note FROM purge_probe`),
        ).toEqual({ body: `{"n":${numeric}}`, note: "note [redacted-key]" })
        expect(fixture.commands).toEqual([["systemctl", "--user", "show-environment"]])
      }),
    ),
  )

  it.live(
    "reports a failing statement by code without echoing the value it carried",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const db = (yield* Database.Service).db
        yield* key(bailian, QWEN)
        yield* db.run(sql`CREATE TABLE purge_probe (id INTEGER PRIMARY KEY, body TEXT)`)
        yield* db.run(sql`INSERT INTO purge_probe (body) VALUES (${`printed ${QWEN}`})`)
        yield* db.run(sql`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('probe', ${QWEN}, 1, 1)`)
        yield* db.run(
          sql`CREATE TRIGGER purge_probe_block BEFORE UPDATE ON purge_probe BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
        )

        const { value: result, entries } = yield* recorded(purge.run({ integrationIDs: [bailian], history: true }))

        expect(result.swept).toEqual([
          { kind: "database", location: "kv.value", count: 1 },
          { kind: "database", location: "purge_probe.body", count: 0, error: expect.any(String) },
        ])
        expect(result.swept[1].error).not.toContain("fake-")
        expect((yield* db.get<{ value: string }>(sql`SELECT value FROM kv WHERE key = 'probe'`))?.value).toBe("[redacted-key]")
        expect(JSON.stringify({ result, entries })).not.toContain("fake-")
        expect(fixture.commands).toEqual([["systemctl", "--user", "show-environment"]])
      }),
    ),
  )

  it.live(
    "wipes every credential, entry, and seed value when all integrations are selected",
    scenario((fixture) =>
      Effect.gen(function* () {
        const purge = yield* CredentialPurge.Service
        const credentials = yield* Credential.Service
        yield* key(bailian, QWEN)
        yield* key(deepseek, DEEPSEEK)
        const authFile = file(fixture, "data", "auth.json")
        yield* write(authFile, JSON.stringify({ [bailian]: { type: "api", key: QWEN }, [deepseek]: { type: "api", key: DEEPSEEK } }, null, 2) + "\n")

        const result = yield* purge.run({ all: true, files: true })

        expect(result.credentials).toHaveLength(2)
        expect(yield* credentials.all()).toEqual([])
        expect(JSON.parse(yield* read(authFile))).toEqual({})
      }),
    ),
  )
})
