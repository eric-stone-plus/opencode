import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Credential } from "@opencode/schema/credential"
import { Session } from "@opencode/schema/session"
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
import { SessionExecution } from "@opencode/core/session/execution"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Global } from "@opencode/util/global"
import { Effect, Layer, Schema } from "effect"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

// An obviously fake value, long enough to be searched for.
const FAKE = "fake-route-key-aaaaaaaaaaaaaaaa"
const OTHER = "fake-route-key-bbbbbbbbbbbbbbbb"

// The server's default Global is the real data directory, so every test roots it in a temporary directory and
// replaces the process spawner: no purge here can reach real credential files or the real user manager.
const handlerFor = (root: string, password?: string, extra: LayerNode.Replacements = []) =>
  ServerFetch.make(
    { ...options, password },
    {
      overrides: [
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
        CrossSpawnSpawner.node.replace(EnvironmentUnavailable.layer),
        ...extra,
      ],
    },
  )

// A server whose process owns one running session.
const busy = SessionExecution.node.replace(
  Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set([Session.ID.make("ses_running")])),
      isActive: () => Effect.succeed(true),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
)

const post = (handler: (request: Request) => Promise<Response>, pathname: string, body: unknown, headers?: HeadersInit) =>
  Effect.promise(() =>
    handler(
      new Request(`http://opencode.local${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ),
  )

const store = (handler: (request: Request) => Promise<Response>, integrationID: string, key: string) =>
  post(handler, "/api/credential", { integrationID, label: "default", value: { type: "key", key } }).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
  )

const listed = (handler: (request: Request) => Promise<Response>) =>
  Effect.promise(async () => {
    const response = await handler(new Request("http://opencode.local/api/credential"))
    const body = (await response.json()) as { data: Array<{ integrationID: string }> }
    return body.data.map((entry) => entry.integrationID).toSorted()
  })

it.live("purges credentials and their stale copies through the HttpApi without returning a value", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* handlerFor(temporary.path)
    yield* store(handler, "bailian-token-plan-personal", FAKE)
    yield* store(handler, "deepseek", OTHER)
    const authFile = path.join(temporary.path, "data", "auth.json")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(authFile), { recursive: true })
      await fs.writeFile(
        authFile,
        JSON.stringify({ "bailian-token-plan-personal": { type: "api", key: FAKE }, deepseek: { type: "api", key: OTHER } }),
      )
    })

    const preview = yield* post(handler, "/api/credential/purge", {
      integrationIDs: ["bailian-token-plan-personal"],
      files: true,
      dryRun: true,
    })
    expect(preview.status).toBe(200)
    expect(yield* listed(handler)).toEqual(["bailian-token-plan-personal", "deepseek"])

    const response = yield* post(handler, "/api/credential/purge", {
      integrationIDs: ["bailian-token-plan-personal"],
      files: true,
    })
    const text = yield* Effect.promise(() => response.text())
    expect(response.status).toBe(200)
    expect(text).not.toContain("fake-")
    const result = Schema.decodeUnknownSync(Schema.Struct({ data: Credential.PurgeResult }))(JSON.parse(text)).data
    expect(result.dryRun).toBe(false)
    expect(result.credentials.map((item) => `${item.integrationID}:${item.removed}`)).toEqual([
      "bailian-token-plan-personal:true",
    ])
    expect(result.swept).toEqual([{ kind: "auth", location: path.join("~", "data", "auth.json"), count: 1 }])
    expect(result.remaining).toEqual([])
    expect(yield* listed(handler)).toEqual(["deepseek"])
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authFile, "utf8")))).toEqual({
      deepseek: { type: "api", key: OTHER },
    })
  }),
)

it.live("rejects a purge that names neither or both of integrationIDs and all", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* handlerFor(temporary.path)
    yield* store(handler, "deepseek", OTHER)

    for (const body of [{}, { integrationIDs: [] }, { files: true }, { all: true, integrationIDs: ["deepseek"] }]) {
      const response = yield* post(handler, "/api/credential/purge", body)
      expect({ body, status: response.status }).toEqual({ body, status: 400 })
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "InvalidRequestError" })
    }
    expect(yield* listed(handler)).toEqual(["deepseek"])
  }),
)

it.live("requires the server password to purge credentials", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* handlerFor(temporary.path, "secret")
    const authorization = { authorization: `Basic ${btoa("opencode:secret")}` }
    yield* post(handler, "/api/credential", { integrationID: "deepseek", value: { type: "key", key: OTHER } }, authorization)

    const denied = yield* post(handler, "/api/credential/purge", { all: true })
    expect(denied.status).toBe(401)

    const allowed = yield* post(handler, "/api/credential/purge", { all: true }, authorization)
    expect(allowed.status).toBe(200)
    const remaining = yield* Effect.promise(async () => {
      const response = await handler(new Request("http://opencode.local/api/credential", { headers: authorization }))
      return ((await response.json()) as { data: unknown[] }).data
    })
    expect(remaining).toEqual([])
  }),
)

it.live("compacts an idle server and previews a compact without rewriting anything", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* handlerFor(temporary.path)
    yield* store(handler, "deepseek", OTHER)

    const preview = yield* post(handler, "/api/credential/purge", { all: true, compact: true, dryRun: true })
    expect(preview.status).toBe(200)
    expect(yield* listed(handler)).toEqual(["deepseek"])

    // The test server's database is in memory, so there is no file to rewrite; idle servers are not refused.
    const response = yield* post(handler, "/api/credential/purge", { all: true, compact: true })
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { data: { compact: { status: string } } }
    expect(body.data.compact.status).toBe("skipped")
    expect(yield* listed(handler)).toEqual([])
  }),
)

it.live("refuses to compact while a session is running, before anything is removed", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const handler = yield* handlerFor(temporary.path, undefined, [busy])
    yield* store(handler, "deepseek", OTHER)

    const refused = yield* post(handler, "/api/credential/purge", { all: true, compact: true })
    expect(refused.status).toBe(409)
    expect(yield* Effect.promise(() => refused.json())).toMatchObject({ _tag: "ConflictError" })
    expect(yield* listed(handler)).toEqual(["deepseek"])

    const preview = yield* post(handler, "/api/credential/purge", { all: true, compact: true, dryRun: true })
    expect(preview.status).toBe(200)
    const purged = yield* post(handler, "/api/credential/purge", { all: true, history: true })
    expect(purged.status).toBe(200)
    expect(yield* listed(handler)).toEqual([])
  }),
)
