export * as SessionAccessToken from "./access-token.js"

import type { Session } from "@opencode/schema/session"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"

/**
 * Mints a credential for one session. The server installs the signing implementation; embedded
 * hosts and tests get the no-op default, which simply leaves `OPENCODE_SESSION_TOKEN` unset.
 */
export interface Interface {
  readonly issue: (sessionID: Session.ID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAccessToken") {}

export const layer = (issue?: (sessionID: Session.ID) => string | undefined) =>
  Layer.succeed(
    Service,
    Service.of({
      issue: (sessionID) => Effect.sync(() => issue?.(sessionID)),
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [],
})
