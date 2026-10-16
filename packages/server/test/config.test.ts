import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    // Project discovery is opt-in twice over: the server must enable it and the host must declare
    // the root as trusted.
    const server = yield* startServer(global, { project: true, trust: { all: false, roots: [project] } })
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("keeps project config undiscovered until the server opts in and declares trust", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-gate-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const globalConfig = path.join(global, "opencode.json")
    const projectConfig = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(globalConfig, JSON.stringify({ model: "base/default" })),
        fs.writeFile(projectConfig, JSON.stringify({ model: "project/default" })),
      ]),
    )
    const closed = yield* startServer(global)
    const closedUrl = new URL("/api/config", closed.base)
    closedUrl.searchParams.set("location[directory]", project)
    const closedResponse = yield* Effect.promise(() => fetch(closedUrl, { headers: closed.headers }))
    const closedEntries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(
      yield* Effect.promise(() => closedResponse.json()),
    )

    expect(closedResponse.status).toBe(200)
    expect(closedEntries.some((entry) => entry.type === "document" && entry.path === globalConfig)).toBe(true)
    expect(closedEntries.some((entry) => entry.type === "document" && entry.path === projectConfig)).toBe(false)

    // `project: true` alone is not an opt-in: without a trust declaration the walk stays closed, so
    // an omitted declaration can never expose a project's own config.
    const untrusted = yield* startServer(global, { project: true })
    const untrustedUrl = new URL("/api/config", untrusted.base)
    untrustedUrl.searchParams.set("location[directory]", project)
    const untrustedResponse = yield* Effect.promise(() => fetch(untrustedUrl, { headers: untrusted.headers }))
    const untrustedEntries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(
      yield* Effect.promise(() => untrustedResponse.json()),
    )

    expect(untrustedResponse.status).toBe(200)
    expect(untrustedEntries.some((entry) => entry.type === "document" && entry.path === projectConfig)).toBe(false)
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
