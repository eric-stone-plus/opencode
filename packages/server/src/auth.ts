export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Session } from "@opencode/schema/session"
import { AccessService, adminAccess, type Access } from "@opencode/protocol/middleware/authorization"

export { AccessService, adminAccess }
export type { Access }

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
export const SESSION_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60
const SESSION_ACCESS_PREFIX = "s1"

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password">) {
    return Layer.succeed(this, this.of({ ...input, username: "opencode" }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

/**
 * Resolve a credential to its authority. Pairing session tokens are operator-equivalent; session
 * access tokens are scoped to the session they were issued for.
 */
export function authenticate(
  credentials: DecodedCredentials,
  config: Info,
  now = Date.now(),
): Access | undefined {
  if (Option.isNone(config.password) || credentials.username !== config.username) return
  const password = Redacted.value(credentials.password)
  if (password === config.password.value || verifySession(password, config, now)) return adminAccess
  const sessionID = verifySessionAccessToken(password, config, now)
  if (sessionID !== undefined) return { kind: "session", sessionID }
}

// Session tokens issued by pairing links are accepted anywhere the password is.
export function authorized(credentials: DecodedCredentials, config: Info) {
  return authenticate(credentials, config) !== undefined
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
export function issueSession(config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${expires}.${sign(config.password.value, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const expires = Number(parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(config.password.value, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Issue a token for one session. The payload is signed with a key derived from the server
 * password, so rotating the password revokes every session access token too.
 */
export function issueSessionAccessToken(password: string, sessionID: Session.ID, now = Date.now()) {
  const expires = String(Math.floor(now / 1000) + SESSION_ACCESS_TTL_SECONDS)
  return `${SESSION_ACCESS_PREFIX}.${expires}.${sessionID}.${signAccess(password, `${expires}.${sessionID}`)}`
}

/** Verify a session access token and return the session it is bound to. */
export function verifySessionAccessToken(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const parts = token.split(".")
  if (parts.length !== 4 || parts[0] !== SESSION_ACCESS_PREFIX) return
  const expires = Number(parts[1])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return
  const sessionID = parts[2]
  if (!sessionID?.startsWith("ses")) return
  const expected = Buffer.from(signAccess(config.password.value, `${parts[1]}.${sessionID}`), "utf8")
  const actual = Buffer.from(parts[3]!, "utf8")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return
  return Session.ID.make(sessionID)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `opencode_session_${port}` : "opencode_session"
}

function sign(password: string, payload: string) {
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}

function signAccess(password: string, payload: string) {
  const key = createHmac("sha256", password).update("opencode-session-access-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}
