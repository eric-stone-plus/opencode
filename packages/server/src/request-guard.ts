import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { isAllowedRequestOrigin, type CorsOptions } from "./cors"

// Browser-facing hardening for the local HTTP API (see GHSA-632h-h47v-g4x4).
//
// CORS only stops a cross-site page from *reading* responses. A top-level form
// post (enctype=text/plain / urlencoded / multipart) or a no-cors fetch still
// reaches the handler, so state-changing requests must be refused before any
// body is parsed:
// - Host: when bound to loopback, only loopback Host names are accepted, so a
//   DNS-rebinding hostname cannot make the browser treat the API as same-origin.
// - Origin / Sec-Fetch-Site: non-safe methods and WebSocket upgrades from
//   origins outside the CORS allowlist are rejected, as are cross-site
//   non-safe requests that omit Origin.
// - Content-Type: non-safe methods only accept JSON bodies (or no declared
//   content type). Every payload route in this API is JSON; there are no
//   multipart/text uploads, and PTY/event streams are GET upgrades.

export type RequestGuardOptions = CorsOptions & {
  // The hostname the listener is bound to. Host validation only applies when
  // this is a loopback name; in-process handlers (no socket) leave it unset.
  readonly hostname?: string
}

type GuardRequest = {
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

export type GuardRejection = {
  readonly status: 403 | 415
  readonly message: string
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function bareHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
}

export function isLoopbackHostname(hostname: string) {
  const host = bareHostname(hostname)
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function hostHeaderName(host: string) {
  try {
    return bareHostname(new URL(`http://${host}`).hostname)
  } catch {
    return undefined
  }
}

export function isAllowedHost(host: string | undefined, opts?: RequestGuardOptions) {
  if (!opts?.hostname || !isLoopbackHostname(opts.hostname)) return true
  // Browsers always send Host; only bare non-browser clients can omit it.
  if (host === undefined) return true
  const name = hostHeaderName(host)
  if (!name) return false
  if (isLoopbackHostname(name)) return true
  if (name === bareHostname(opts.hostname)) return true
  // Reverse proxies in front of a loopback listener can be allowed by listing
  // their public origin in --cors / server.cors.
  return (opts.cors ?? []).some((origin) => {
    try {
      return bareHostname(new URL(origin).hostname) === name
    } catch {
      return false
    }
  })
}

export function isJsonContentType(contentType: string | undefined) {
  // Effect's HttpApi decoder treats a missing content type as JSON.
  if (contentType === undefined) return true
  return contentType.split(";")[0].trim().toLowerCase() === "application/json"
}

export function checkRequest(request: GuardRequest, opts?: RequestGuardOptions): GuardRejection | undefined {
  const headers = request.headers
  if (!isAllowedHost(headers.host, opts)) return { status: 403, message: "Host not allowed" }

  // WebSocket handshakes are GETs that CORS never applies to, so a cross-site
  // page could otherwise attach to a PTY when no password is configured.
  const websocket = headers.upgrade?.toLowerCase() === "websocket"
  if (SAFE_METHODS.has(request.method.toUpperCase()) && !websocket) return undefined

  const origin = headers.origin
  if (origin !== undefined && !isAllowedRequestOrigin(origin, headers.host, opts)) {
    return { status: 403, message: "Origin not allowed" }
  }
  if (websocket) return undefined
  if (origin === undefined && headers["sec-fetch-site"]?.toLowerCase() === "cross-site") {
    return { status: 403, message: "Cross-site request not allowed" }
  }
  if (!isJsonContentType(headers["content-type"])) {
    return { status: 415, message: `Unsupported content-type: ${headers["content-type"]}` }
  }
  return undefined
}

export function rejectionResponse(rejection: GuardRejection) {
  return HttpServerResponse.jsonUnsafe({ error: rejection.message }, { status: rejection.status })
}

export function unsupportedMediaType(contentType: string | undefined) {
  return rejectionResponse({ status: 415, message: `Unsupported content-type: ${contentType}` })
}

export const requestGuard = (opts?: RequestGuardOptions) =>
  HttpRouter.middleware(
    (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const rejection = checkRequest(request, opts)
        if (rejection) return rejectionResponse(rejection)
        return yield* effect
      }),
    { global: true },
  )
