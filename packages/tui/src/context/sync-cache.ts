// Bounds for the per-session caches held by the Sync store (messages, parts,
// todo, diff, goal). Long-running TUIs see many child/background sessions; only
// the sessions the user is looking at need to stay resident, everything else
// is re-hydrated by session.sync() when it is opened again.

/** Non-protected sessions kept resident besides the route session and its running children. */
export const SESSION_CACHE_MAX = 5

/** Most-recently-used ordering of session IDs; iteration order is oldest first. */
export function createSessionLRU() {
  const order = new Map<string, true>()
  return {
    /** Marks the session as most recently used; returns true when it was not tracked before. */
    touch(sessionID: string) {
      const fresh = !order.has(sessionID)
      order.delete(sessionID)
      order.set(sessionID, true)
      return fresh
    },
    delete(sessionID: string) {
      order.delete(sessionID)
    },
    keys() {
      return [...order.keys()]
    },
  }
}

/**
 * Sessions to evict: the oldest non-protected entries beyond `max`.
 * `order` is oldest first; protected sessions neither count toward nor are evicted by the limit.
 */
export function sessionsToEvict(input: { order: string[]; keep: ReadonlySet<string>; max: number }) {
  const candidates = input.order.filter((sessionID) => !input.keep.has(sessionID))
  return candidates.slice(0, Math.max(0, candidates.length - input.max))
}

/**
 * Sessions that must stay resident: the route session, its parent (the view the
 * user returns to), and every non-idle child of either.
 */
export function protectedSessions(input: {
  route: string | undefined
  sessions: readonly { id: string; parentID?: string }[]
  busy(sessionID: string): boolean
}) {
  const keep = new Set<string>()
  if (!input.route) return keep
  keep.add(input.route)
  const parent = input.sessions.find((session) => session.id === input.route)?.parentID
  if (parent) keep.add(parent)
  for (const session of input.sessions) {
    if (!session.parentID || !keep.has(session.parentID)) continue
    if (input.busy(session.id)) keep.add(session.id)
  }
  return keep
}

/** A part event may only be stored when its message is resident; otherwise it would create an orphan entry. */
export function knownMessage(messages: readonly { id: string }[] | undefined, messageID: string) {
  return !!messages?.some((message) => message.id === messageID)
}
