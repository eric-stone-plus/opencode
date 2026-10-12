export * as ForkCards from "./cards.js"

import { Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect } from "effect"

/** The text of every single-part user message in a request, which is where standing reminders live. */
export const texts = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    return part?.type === "text" ? [part.text] : []
  })

/**
 * Standing reminders are persisted once as synthetic messages and then live in history, so later requests
 * stay byte-identical and keep hitting the provider prompt cache. A caller passes the reminders the model
 * should see right now; this persists the ones history does not hold yet and splices them into the request.
 */
export function make(ctx: Pick<Context, "session">) {
  // A persisted reminder only reaches history when the runner promotes it at the next step boundary. A retry
  // inside the same step reloads history before that, so without this ledger every retry would persist the
  // same reminder again and the next boundary would promote all the copies.
  const waiting = new Map<string, string[]>()

  const apply = Effect.fn("ForkCards.apply")(function* (event: SessionContext, wanted: ReadonlyArray<string>) {
    const live = texts(event.messages)
    const pending = (waiting.get(event.sessionID) ?? []).filter((text) => !live.includes(text))
    const fresh = wanted.filter((text) => !pending.includes(text))
    const admitted = yield* Effect.filter(fresh, (text) =>
      ctx.session.synthetic({ sessionID: event.sessionID, text, resume: false }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist standing reminder", { sessionID: event.sessionID, cause }).pipe(
            Effect.as(false),
          ),
        ),
      ),
    )
    const next = [...pending, ...admitted]
    if (next.length === 0) waiting.delete(event.sessionID)
    else waiting.set(event.sessionID, next)
    const show = [...pending, ...fresh]
    if (show.length === 0) return
    // Before the user's prompt, matching where agent-switch reminders land.
    const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
    event.messages.splice(at, 0, ...show.map((text) => Message.user(text)))
  })

  return { apply, forget: (sessionID: string) => void waiting.delete(sessionID) }
}
