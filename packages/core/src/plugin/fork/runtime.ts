export * as ForkRuntimePlugin from "./runtime.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ForkDoomLoop } from "../../session/fork/doom-loop.js"
import type { PluginInternal } from "../internal.js"

/** Long-run hardening for unattended Sessions that V2 has no equivalent for. */
export const Plugin = define({
  id: "opencode.fork.runtime",
  effect: Effect.fn("ForkRuntimePlugin")(function* (ctx) {
    const streaks = ForkDoomLoop.make()
    // Sessions whose next model request must not happen. The stop waits for that request so the refusal that
    // earned it is already recorded as the last tool result when the run ends.
    const stopping = new Set<string>()

    yield* ctx.tool.hook("execute.before", (event) => {
      const count = streaks.record(event.sessionID, event.id, event.tool, event.input)
      if (count < ForkDoomLoop.THRESHOLD) return Effect.void
      if (count >= ForkDoomLoop.STOP) stopping.add(event.sessionID)
      return Effect.logWarning("refusing a repeated tool call", {
        sessionID: event.sessionID,
        tool: event.tool,
        count,
      }).pipe(Effect.andThen(Effect.fail(new ToolFailure({ message: ForkDoomLoop.message(event.tool, count) }))))
    })

    yield* ctx.session.hook("context", (event) =>
      stopping.delete(event.sessionID) ? ctx.session.interrupt({ sessionID: event.sessionID }).pipe(Effect.ignore) : Effect.void,
    )

    // A new user turn starts a new run of calls.
    yield* ctx.session.hook("prompt", (event) =>
      Effect.sync(() => {
        streaks.reset(event.sessionID)
        stopping.delete(event.sessionID)
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
