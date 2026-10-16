export * as SessionAffinity from "./affinity.js"

import type { SessionSchema } from "./schema.js"

// No plugin hook exposes affinity: the provider plugins that derived it from `ctx.session.get` were
// removed with the vendor prune, and `SessionAffinity.get` has no other consumer than model-request.
/** The Session ID that groups model requests for provider cache routing: children share the parent's, forks the fork source's. */
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id
