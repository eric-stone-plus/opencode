import { afterEach, describe, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { request as httpRequest } from "node:http"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { checkRequest, isAllowedHost } from "@opencode-ai/server/request-guard"
import { isAllowedCorsOrigin } from "@opencode-ai/server/cors"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Database.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const it = testEffect(
  Layer.mergeAll(
    appLayer,
    servedRoutes.pipe(
      Layer.provide(layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

// The exact body from GHSA-632h-h47v-g4x4: an HTML form with enctype=text/plain
// and a field named `{"target":"x","x":"` with value `"}` serializes to valid JSON.
const ADVISORY_BODY = '{"target":"x","x":"="}'

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname + url.search),
    HttpClient.execute,
  )
}

function sessionCount(directory: string) {
  return request(SessionPaths.list, { headers: { "x-opencode-directory": directory } }).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((sessions) => (sessions as unknown[]).length),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("request guard (pure)", () => {
  test("rejects non-JSON bodies on state-changing methods", () => {
    for (const contentType of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ]) {
      expect(checkRequest({ method: "POST", headers: { "content-type": contentType } })?.status).toBe(415)
    }
    expect(checkRequest({ method: "POST", headers: { "content-type": "application/json; charset=utf-8" } })).toBe(
      undefined,
    )
    expect(checkRequest({ method: "POST", headers: {} })).toBe(undefined)
    expect(checkRequest({ method: "GET", headers: { "content-type": "text/plain" } })).toBe(undefined)
  })

  test("rejects disallowed origins and cross-site requests without Origin", () => {
    expect(checkRequest({ method: "POST", headers: { origin: "https://evil.example" } })?.status).toBe(403)
    expect(checkRequest({ method: "DELETE", headers: { origin: "null" } })?.status).toBe(403)
    expect(checkRequest({ method: "PATCH", headers: { "sec-fetch-site": "cross-site" } })?.status).toBe(403)
    expect(checkRequest({ method: "POST", headers: { origin: "http://localhost:3000" } })).toBe(undefined)
    expect(checkRequest({ method: "POST", headers: { origin: "oc://renderer", "sec-fetch-site": "cross-site" } })).toBe(
      undefined,
    )
    expect(
      checkRequest(
        { method: "POST", headers: { origin: "https://custom.example" } },
        { cors: ["https://custom.example"] },
      ),
    ).toBe(undefined)
    expect(checkRequest({ method: "POST", headers: { "sec-fetch-site": "same-origin" } })).toBe(undefined)
    // Reads stay open to any origin; CORS keeps their responses private.
    expect(checkRequest({ method: "GET", headers: { origin: "https://evil.example" } })).toBe(undefined)
  })

  test("checks Origin on WebSocket upgrades", () => {
    expect(
      checkRequest({ method: "GET", headers: { upgrade: "websocket", origin: "https://evil.example" } })?.status,
    ).toBe(403)
    expect(checkRequest({ method: "GET", headers: { upgrade: "websocket", origin: "http://127.0.0.1:4096" } })).toBe(
      undefined,
    )
  })

  test("validates Host only for loopback listeners", () => {
    const loopback = { hostname: "127.0.0.1" }
    expect(isAllowedHost("127.0.0.1:4096", loopback)).toBe(true)
    expect(isAllowedHost("localhost:4096", loopback)).toBe(true)
    expect(isAllowedHost("[::1]:4096", loopback)).toBe(true)
    expect(isAllowedHost("rebind.evil.example:4096", loopback)).toBe(false)
    expect(isAllowedHost("127.0.0.1.evil.example", loopback)).toBe(false)
    expect(isAllowedHost(undefined, loopback)).toBe(true)
    expect(isAllowedHost("proxy.example", { hostname: "127.0.0.1", cors: ["https://proxy.example"] })).toBe(true)
    expect(isAllowedHost("anything.example", { hostname: "0.0.0.0" })).toBe(true)
    expect(isAllowedHost("anything.example", {})).toBe(true)
    // Rebinding requests carry a matching Origin, so Origin checks alone pass them.
    expect(
      checkRequest(
        { method: "POST", headers: { host: "rebind.evil.example:4096", origin: "http://rebind.evil.example:4096" } },
        loopback,
      )?.status,
    ).toBe(403)
  })

  test("no longer trusts upstream web origins", () => {
    expect(isAllowedCorsOrigin("https://app.opencode.ai")).toBe(false)
    expect(isAllowedCorsOrigin("https://dev.opencode.ai")).toBe(false)
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:4096")).toBe(true)
    expect(isAllowedCorsOrigin("http://localhost.evil.example")).toBe(false)
    expect(isAllowedCorsOrigin("oc://renderer")).toBe(true)
    expect(isAllowedCorsOrigin("oc://renderer.evil")).toBe(false)
    expect(isAllowedCorsOrigin("tauri://localhost")).toBe(true)
  })
})

describe("request guard (HttpApi)", () => {
  it.instance(
    "refuses the advisory's text/plain body on raw JSON handlers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const before = yield* sessionCount(test.directory)
        for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
          const create = yield* request(SessionPaths.create, {
            method: "POST",
            headers: { "x-opencode-directory": test.directory, "content-type": contentType },
            body: ADVISORY_BODY,
          })
          expect(create.status).toBe(415)
        }
        // `permission` lets a caller pre-grant every tool; it must never arrive via a form.
        const permission = yield* request(SessionPaths.create, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
        })
        expect(permission.status).toBe(415)
        expect(yield* sessionCount(test.directory)).toBe(before)

        const fork = yield* request(SessionPaths.fork.replace(":sessionID", "ses_missing"), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "text/plain" },
          body: ADVISORY_BODY,
        })
        expect(fork.status).toBe(415)

        const authorize = yield* request("/provider/openai/oauth/authorize", {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "text/plain" },
          body: '{"method":0}',
        })
        expect(authorize.status).toBe(415)

        const upgrade = yield* request(GlobalPaths.upgrade, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: ADVISORY_BODY,
        })
        expect(upgrade.status).toBe(415)

        const config = yield* request(GlobalPaths.config, {
          method: "PATCH",
          headers: { "content-type": "text/plain" },
          body: '{"share":"auto"}',
        })
        expect(config.status).toBe(415)

        // JSON from an allowed local origin still works.
        const allowed = yield* request(SessionPaths.create, {
          method: "POST",
          headers: {
            "x-opencode-directory": test.directory,
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ title: "ok" }),
        })
        expect(allowed.status).toBe(200)
        expect(yield* sessionCount(test.directory)).toBe(before + 1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "refuses state-changing requests from disallowed origins",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const before = yield* sessionCount(test.directory)
        const crossOrigin = yield* request(SessionPaths.create, {
          method: "POST",
          headers: {
            "x-opencode-directory": test.directory,
            "content-type": "application/json",
            origin: "https://evil.example",
          },
          body: "{}",
        })
        expect(crossOrigin.status).toBe(403)

        // no-cors fetch with an untyped Blob sends no content-type; Sec-Fetch-Site still marks it.
        const crossSite = yield* request(SessionPaths.create, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "sec-fetch-site": "cross-site" },
        })
        expect(crossSite.status).toBe(403)

        const upstream = yield* request(GlobalPaths.config, {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: "https://app.opencode.ai" },
          body: "{}",
        })
        expect(upstream.status).toBe(403)
        expect(yield* sessionCount(test.directory)).toBe(before)

        const read = yield* request(InstancePaths.path, {
          headers: { "x-opencode-directory": test.directory, origin: "https://evil.example" },
        })
        expect(read.status).toBe(200)
        expect(read.headers["access-control-allow-origin"]).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("rejects WebSocket upgrades from disallowed origins", () =>
    Effect.gen(function* () {
      const response = yield* request("/pty/pty_missing/connect", {
        headers: { upgrade: "websocket", connection: "Upgrade", origin: "https://evil.example" },
      })
      expect(response.status).toBe(403)
    }),
  )
})

describe("listener Host validation", () => {
  function rawGet(url: URL, host: string) {
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: GlobalPaths.health, headers: { host } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on("error", reject)
      req.end()
    })
  }

  it.live("rejects DNS-rebinding Host headers on a loopback listener", () =>
    Effect.gen(function* () {
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const port = listener.port
      expect(yield* Effect.promise(() => rawGet(listener.url, `rebind.evil.example:${port}`))).toBe(403)
      expect(yield* Effect.promise(() => rawGet(listener.url, `127.0.0.1:${port}`))).toBe(200)
      expect(yield* Effect.promise(() => rawGet(listener.url, `localhost:${port}`))).toBe(200)
    }),
  )
})
