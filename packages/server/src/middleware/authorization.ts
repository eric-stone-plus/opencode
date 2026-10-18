import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Authorization } from "@opencode/protocol/middleware/authorization"
export { Authorization } from "@opencode/protocol/middleware/authorization"
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "@opencode/protocol/groups/pty"
import { PERSISTENT_PTY_CONNECT_PATH } from "@opencode/protocol/groups/persistent-pty"
import { PAIRING_CONNECT_PATH } from "@opencode/protocol/groups/server"
import { Effect, Layer, Redacted } from "effect"
import { Base64 } from "effect/encoding"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Base64.decodeString(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const authorization = request.headers.authorization ?? ""
  const basic = /^Basic\s+(.+)$/i.exec(authorization)
  if (basic) return decodeCredential(basic[1])
  // Bearer is the natural form for a session access token; Basic stays the CLI's transport.
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)
  if (bearer) return Effect.succeed({ username: "opencode", password: Redacted.make(bearer[1]!) })
  return Effect.succeed(emptyCredential())
}

const UNAUTHORIZED_MESSAGE = "Authentication required"

// Browsers show a native credentials prompt for a Basic challenge even on fetch, which would stall the web app
// before it can show its own sign-in screen. Only non-browser clients and page navigations get the challenge.
function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  const mode = request.headers["sec-fetch-mode"]
  return mode === undefined || mode === "navigate"
}

// Matches what the Authorization middleware encodes, for requests rejected before the HttpApi runs.
export function unauthorizedResponse(request: HttpServerRequest.HttpServerRequest) {
  return HttpServerResponse.jsonUnsafe(
    { _tag: "UnauthorizedError", message: UNAUTHORIZED_MESSAGE },
    { status: 401, headers: challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : undefined },
  )
}

export function authenticateRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(
    Effect.map(
      (credential) =>
        ServerAuth.authenticate(credential, config) ??
        (authorizedSessionCookie(request, config) ? ServerAuth.adminAccess : undefined),
    ),
  )
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return authenticateRequest(request, config).pipe(Effect.map((access) => access !== undefined))
}

function authorizedSessionCookie(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  const token = request.cookies[ServerAuth.sessionCookieName(request.headers.host)]
  if (!token) return false
  // Same-site pages on other ports still send this cookie, so only same-origin requests may use it.
  const origin = request.headers.origin
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host) return false
  return ServerAuth.verifySession(token, config)
}

/**
 * Routes a session-scoped credential may use when the route has no `sessionID` parameter.
 * Everything else is denied by default: a token for one session must not reach the global event
 * feed, plugin RPC, file APIs (which could expose the database), or operator-only controls.
 */
function sessionRouteAllowed(path: string, method: string) {
  if (path === "/api/info" || path === "/api/location") return true
  if (path === "/api/session") return method === "GET"
  if (path === "/api/session/active") return true
  if (path === "/api/shell") return method === "GET"
  if (path === "/api/shell/:id" || path === "/api/shell/:id/output") return method === "GET" || method === "DELETE"
  return false
}

// A session token is a read credential: it may inspect its own session, not drive it. Prompt
// attachments can read arbitrary file:// paths, and update/move/remove/fork/command are operator
// actions; the agent's own loop runs in-process. Keep this default-deny for new routes.
function sessionMethodAllowed(method: string) {
  return method === "GET" || method === "HEAD"
}

// These session-scoped routes spawn a process without the shell tool's environment hook, so a
// command run through them would not receive the session token and could fall back to the
// operator credential. The agent's own shell tool is the supported path.
function sessionScopedRouteDenied(path: string) {
  return (
    path === "/api/session/:sessionID/shell" ||
    path === "/api/experimental/session/:sessionID/terminal" ||
    path === "/api/experimental/session/:sessionID/terminal/read"
  )
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config))
      return Authorization.of((effect) =>
        Effect.provideService(effect, ServerAuth.AccessService, ServerAuth.adminAccess),
      )
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = yield* HttpRouter.RouteContext
        // Ticketed PTY connects (browsers cannot set headers on WebSocket upgrades) and pairing links
        // skip credential checks here; their handlers consume and validate the ticket or code. Use the
        // route selected by Effect so authorization and dispatch cannot disagree about the request path.
        const url = new URL(request.url, "http://localhost")
        if (
          ((route.route.path === PTY_CONNECT_PATH || route.route.path === PERSISTENT_PTY_CONNECT_PATH) &&
            !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)) ||
          route.route.path === PAIRING_CONNECT_PATH
        )
          return yield* effect.pipe(
            Effect.provideService(ServerAuth.AccessService, ServerAuth.adminAccess),
          )
        const access = yield* authenticateRequest(request, config)
        if (access === undefined) {
          if (challengeRequest(request))
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
            )
          return yield* new UnauthorizedError({ message: UNAUTHORIZED_MESSAGE })
        }
        if (access.kind === "session") {
          const scoped = route.params.sessionID
          if (typeof scoped === "string") {
            if (scoped !== access.sessionID)
              return yield* new UnauthorizedError({ message: "Session access token does not match this session" })
            if (sessionScopedRouteDenied(route.route.path))
              return yield* new UnauthorizedError({ message: "Session access token cannot use this route" })
            if (!sessionMethodAllowed(request.method))
              return yield* new UnauthorizedError({ message: "Session access token is read-only" })
          } else if (!sessionRouteAllowed(route.route.path, request.method)) {
            return yield* new UnauthorizedError({ message: "Session access token cannot use this route" })
          }
        }
        return yield* effect.pipe(Effect.provideService(ServerAuth.AccessService, access))
      }),
    )
  }),
)
