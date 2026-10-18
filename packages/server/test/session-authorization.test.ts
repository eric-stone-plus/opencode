import { expect } from "bun:test"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { Shell } from "@opencode/core/shell"
import { ServerAuth } from "@opencode/server/auth"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

it.live("a session access token can read only its own session", () =>
  Effect.gen(function* () {
    const first = yield* tmpdirScoped()
    const second = yield* tmpdirScoped()
    yield* Effect.promise(() => fs.writeFile(path.join(second.path, "secret.txt"), "second session only"))

    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        config: { directory: first.path, project: false, content: "{}" },
        fs: { filewatcher: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const sessions = Context.get(context, Session.Service)
    const locations = Context.get(context, LocationServiceMap.Service)
    const firstSession = yield* sessions.create({
      title: "first",
      location: Location.Ref.make({ directory: AbsolutePath.make(first.path) }),
    })
    const secondSession = yield* sessions.create({
      title: "second",
      location: Location.Ref.make({ directory: AbsolutePath.make(second.path) }),
    })
    const token = ServerAuth.issueSessionAccessToken("secret", firstSession.id)
    if (!token) throw new Error("Expected a session access token")

    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const request = (route: string, password: string, init: RequestInit = {}) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${route}`, {
            ...init,
            headers: { ...init.headers, authorization: basic(password) },
          }),
        ),
      )

    // Own session: get, export, messages, and log are all readable.
    for (const route of [
      `/api/session/${firstSession.id}`,
      `/api/experimental/session/${firstSession.id}/export`,
      `/api/session/${firstSession.id}/message`,
      `/api/experimental/session/${firstSession.id}/log`,
    ]) {
      const response = yield* request(route, token)
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    }

    // Listing is reduced to the token's own session, not a filtered page of every session.
    const listed = yield* request("/api/session", token)
    expect(listed.status).toBe(200)
    const listedBody = yield* Effect.promise<{ data: ReadonlyArray<{ id: string }> }>(() => listed.json())
    expect(listedBody.data.map((session) => session.id)).toEqual([firstSession.id])

    // Every cross-session route and the global event feed are denied.
    for (const route of [
      `/api/session/${secondSession.id}`,
      `/api/session/${secondSession.id}/message`,
      `/api/experimental/session/${secondSession.id}/export`,
      `/api/experimental/session/${secondSession.id}/log`,
      `/api/experimental/session/stats?session=${secondSession.id}`,
      "/api/event",
      `/api/rpc/example/method?location[directory]=${encodeURIComponent(second.path)}`,
    ]) {
      const response = yield* request(route, token, route.startsWith("/api/rpc") ? { method: "POST" } : undefined)
      expect(response.status).toBe(401)
    }

    // File APIs are operator-only for a session token: fs.read could otherwise reach the
    // server's database, and fs.list can escape the location with an absolute path.
    for (const route of [
      `/api/fs/read/secret.txt?location[directory]=${encodeURIComponent(first.path)}`,
      `/api/fs/read/secret.txt?location[directory]=${encodeURIComponent(second.path)}`,
      `/api/fs/list?location[directory]=${encodeURIComponent(second.path)}`,
    ]) {
      const response = yield* request(route, token)
      expect(response.status).toBe(401)
    }

    // Own-session routes that spawn a process without the shell tool's environment hook are
    // denied: the command would not receive the token and could fall back to the operator credential.
    for (const route of [
      `/api/session/${firstSession.id}/shell`,
      `/api/experimental/session/${firstSession.id}/terminal`,
    ]) {
      const response = yield* request(route, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(401)
    }

    // The location is still pinned to the token's session for the routes it may use.
    const pinned = yield* request(
      `/api/location?location[directory]=${encodeURIComponent(second.path)}`,
      token,
    )
    expect(pinned.status).toBe(200)
    const pinnedBody = yield* Effect.promise<{ directory: string }>(() => pinned.json())
    expect(pinnedBody.directory).toBe(firstSession.location.directory)

    // Shell output is owned by metadata, even when both shells share a location.
    const shellID = yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const info = yield* shell.create({
        command: process.platform === "win32" ? "Write-Output owned" : "printf owned",
        metadata: { sessionID: secondSession.id },
      })
      return info.id
    }).pipe(Effect.provide(locations.get(firstSession.location)))
    const foreignShell = yield* request(
      `/api/shell/${shellID}/output?location[directory]=${encodeURIComponent(first.path)}`,
      token,
    )
    expect(foreignShell.status).toBe(404)

    // The operator password still sees everything.
    for (const route of [
      `/api/session/${secondSession.id}`,
      `/api/session/${secondSession.id}/message`,
      `/api/experimental/session/${secondSession.id}/export`,
      `/api/experimental/session/${secondSession.id}/log`,
      "/api/event",
      `/api/shell/${shellID}/output?location[directory]=${encodeURIComponent(first.path)}`,
    ]) {
      const response = yield* request(route, "secret")
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    }
    const adminList = yield* request("/api/session", "secret")
    expect(adminList.status).toBe(200)
    const adminBody = yield* Effect.promise<{ data: ReadonlyArray<{ id: string }> }>(() => adminList.json())
    expect(adminBody.data.map((session) => session.id).sort()).toEqual(
      [firstSession.id, secondSession.id].sort(),
    )
    const adminFile = yield* request(
      `/api/fs/read/secret.txt?location[directory]=${encodeURIComponent(second.path)}`,
      "secret",
    )
    expect(adminFile.status).toBe(200)
    yield* Effect.promise(() => adminFile.body?.cancel() ?? Promise.resolve())

    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      yield* shell.remove(shellID).pipe(Effect.ignore)
    }).pipe(Effect.provide(locations.get(firstSession.location)))
  }),
)
