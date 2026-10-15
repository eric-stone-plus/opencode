export * as ForkSubagentInterruptPlugin from "./interrupt.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Job } from "../../job.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentTool } from "../../tool/plugin/subagent.js"

/**
 * Stopping a subagent the model started (borrow C9, the interrupt surface).
 *
 * A spawn is one-way today: the model starts a child, gets a session ID back, and the only way to stop
 * a child that went down the wrong path is for the user to interrupt the whole session. The subagent
 * tool itself already knows how to stop a child - it does it when the user interrupts a foreground
 * spawn - so this exposes the same pair of calls to the model, with the ownership check the tool's own
 * path does not need: a child may only be stopped by the session that spawned it.
 *
 * The declaration rides on the spawn schema through the tool editor, so the upstream tool file stays
 * untouched and the field is visible in the subagent definition the model reads.
 */

/** Whether `caller` may stop this session: only a session's own children are fair game. */
export const interruptable = (
  child: { readonly parentID?: SessionSchema.ID } | undefined,
  caller: SessionSchema.ID,
) => child !== undefined && child.parentID === caller

const Interrupt = Schema.Boolean.annotate({
  description:
    "Set together with sessionID to stop a running subagent instead of starting one. Only a subagent this session started can be stopped.",
})

export const Plugin = define({
  id: "fork.subagent-interrupt",
  effect: Effect.fn("ForkSubagentInterruptPlugin")(function* (ctx) {
    const jobs = yield* Job.Service

    yield* ctx.tool.transform((editor) =>
      editor.update(SubagentTool.name, (tool) => {
        // `ValueSchema` is the registry's heterogeneous type; this plugin targets the subagent tool by
        // id, so its input is a Struct by construction and this is the single place that knows it.
        const fields = (tool.input as unknown as Schema.Struct<Schema.Struct.Fields>).fields
        tool.input = Schema.Struct({ ...fields, interrupt: Schema.optional(Interrupt) })
        const spawn = tool.execute
        tool.execute = (input, context) =>
          Effect.gen(function* () {
            const declared = input as { readonly sessionID?: SessionSchema.ID; readonly interrupt?: boolean }
            if (declared.interrupt !== true) return yield* spawn(input, context)
            const sessionID = declared.sessionID
            if (sessionID === undefined)
              return yield* new ToolFailure({ message: "interrupt requires the sessionID of the subagent to stop." })
            const child = yield* ctx.session.get({ sessionID }).pipe(Effect.orElseSucceed(() => undefined))
            // Without this check any session could stop any other session by guessing an ID, and the
            // model has both a list of sessions and a reason to try.
            if (!interruptable(child, context.sessionID))
              return yield* new ToolFailure({ message: `No subagent of this session has sessionID ${sessionID}.` })
            const stopped = yield* ctx.session
              .interrupt({ sessionID })
              .pipe(Effect.orElseSucceed(() => ({ interrupted: false })))
            // The session stops running; its job has to be cancelled too, or the spawn that is waiting on
            // it stays open. Same pair the tool uses when the user interrupts a foreground spawn.
            yield* jobs.cancel(sessionID).pipe(Effect.orElseSucceed(() => undefined))
            return {
              output: {
                sessionID,
                status: "completed" as const,
                output: stopped.interrupted
                  ? `Interrupted subagent ${sessionID}. Its session keeps its history, so you can continue it later.`
                  : `Subagent ${sessionID} was not running.`,
              },
            }
          })
      }),
    )
  }),
})
