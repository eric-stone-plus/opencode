import { Context } from "effect"
import { HttpApiMiddleware } from "effect/http-api"
import type { Session } from "@opencode/schema/session"
import { UnauthorizedError } from "../errors.js"

/**
 * The authority attached to an authenticated request. A session access token is deliberately
 * narrower than the operator password: it names exactly one session.
 */
export type Access =
  | { readonly kind: "admin" }
  | { readonly kind: "session"; readonly sessionID: Session.ID }

export class AccessService extends Context.Service<AccessService, Access>()("@opencode/HttpApiAccess") {}

export const adminAccess: Access = { kind: "admin" }

export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: AccessService }
>()("@opencode/HttpApiAuthorization", {
  error: UnauthorizedError,
}) {}
