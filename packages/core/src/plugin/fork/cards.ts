export * as ForkCards from "./cards.js"

import { SystemPart } from "@opencode/ai"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect } from "effect"

/**
 * Standing reminders ride on the request's system parts. Persisting them as synthetic messages made the
 * runner reload the parent context inside a step, which swallowed subagent completion notices
 * (test/config/command-subagent.test.ts); a request is rebuilt on every call, so a card is simply present
 * while it applies and gone on the next request once it stops applying.
 */
export function make() {
  const apply = Effect.fn("ForkCards.apply")(function* (event: SessionContext, wanted: ReadonlyArray<string>) {
    if (wanted.length === 0) return
    event.system.push(...wanted.map((text) => SystemPart.make(text)))
  })
  return { apply }
}
