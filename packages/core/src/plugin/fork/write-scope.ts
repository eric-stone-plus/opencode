export * as ForkWriteScopePlugin from "./write-scope.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "node:path"
import { Job } from "../../job.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentTool } from "../../tool/plugin/subagent.js"

/**
 * Declared write scopes for sibling subagents (borrow C33, soft by default).
 *
 * The subagent tool already tells the model to "avoid working with the same files or topics" as a
 * running child, and nothing enforces it: two background children can be pointed at the same tree and
 * the second one's edits land on top of the first one's. This adds a declaration to the spawn call -
 * `writeRoots`, the paths the child is expected to write - and refuses a spawn whose declaration
 * overlaps a live sibling's.
 *
 * Deliberately soft: a spawn that declares nothing is untouched, so the surface stays optional and no
 * existing call changes behavior. Enforcing that every spawn declares its scope, or that a child
 * writes nothing outside its declaration, is a stricter mode and stays an owner decision - it changes
 * what the seat accepts rather than what it reports.
 *
 * Claim lifetime needs no bookkeeping: the subagent tool starts one job per child under the child's
 * own session ID (`jobs.start({ id: child.id })`), so a claim is active exactly while `jobs.get(child)`
 * reports a running job, and stale entries are pruned on the next check.
 */

/** A live declaration: the roots one child session declared under one parent session. */
export interface Claim {
  readonly sessionID: SessionSchema.ID
  readonly parentSessionID: SessionSchema.ID
  readonly roots: readonly string[]
}

/**
 * Path overlap, at a directory boundary: `/a/b` covers `/a/b/c` but not `/a/bc`. Both sides are
 * resolved before they get here, so equality is the file case and the prefix test is the tree case.
 */
export function overlaps(left: string, right: string) {
  if (left === right) return true
  const covers = (parent: string, child: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  return covers(left, right) || covers(right, left)
}

/**
 * The first live sibling claim that overlaps a new declaration. Siblings only: a different parent's
 * child is a different workstream, and the parent that orchestrates both is not this tool's business.
 */
export function conflict(
  claims: readonly Claim[],
  input: { readonly parentSessionID: SessionSchema.ID; readonly roots: readonly string[] },
): Claim | undefined {
  return claims.find(
    (claim) =>
      claim.parentSessionID === input.parentSessionID &&
      claim.roots.some((root) => input.roots.some((other) => overlaps(root, other))),
  )
}

const WriteRoots = Schema.Array(Schema.String).annotate({
  description:
    "Paths this subagent is expected to write, relative to the workspace or absolute. Declare them to keep two subagents off the same files: a spawn whose roots overlap a running sibling's declared roots is refused. Omit the field to leave the spawn unchecked.",
})

export const Plugin = define({
  id: "fork.write-scope",
  effect: Effect.fn("ForkWriteScopePlugin")(function* (ctx) {
    const jobs = yield* Job.Service
    const claims = new Map<SessionSchema.ID, Claim>()
    const directory = ctx.location.directory

    const active = Effect.fnUntraced(function* () {
      for (const [sessionID] of claims) {
        const job = yield* jobs.get(sessionID)
        if (job?.status !== "running") claims.delete(sessionID)
      }
      return Array.from(claims.values())
    })

    yield* ctx.tool.transform((editor) =>
      editor.update(SubagentTool.name, (tool) => {
        // Extend the spawn schema instead of editing the tool: the model sees `writeRoots` in the
        // subagent definition, and the registry decodes it through this schema at call time.
        // `ValueSchema` is the registry's heterogeneous type; this plugin targets the subagent tool by
        // id, so its input is a Struct by construction and this is the single place that knows it.
        const fields = (tool.input as unknown as Schema.Struct<Schema.Struct.Fields>).fields
        tool.input = Schema.Struct({ ...fields, writeRoots: Schema.optional(WriteRoots) })
        const spawn = tool.execute
        tool.execute = (input, context) =>
          Effect.gen(function* () {
            const declared = (input as { readonly writeRoots?: readonly string[] }).writeRoots
            if (declared === undefined) return yield* spawn(input, context)
            const roots = declared.map((root) => path.resolve(directory, root))
            const clash = conflict(yield* active(), { parentSessionID: context.sessionID, roots })
            if (clash)
              return yield* new ToolFailure({
                message: `Write scope overlaps subagent ${clash.sessionID} (${clash.roots.join(", ")}). Pick different paths, wait for it to finish, or omit writeRoots.`,
              })
            // The child's session ID only exists once the tool created it, and the tool reports it
            // through progress after create and before the first prompt, so binding there is race-free.
            return yield* spawn(input, {
              ...context,
              progress: (update) => {
                const sessionID = update?.["sessionID"]
                if (typeof sessionID === "string")
                  claims.set(sessionID as SessionSchema.ID, {
                    sessionID: sessionID as SessionSchema.ID,
                    parentSessionID: context.sessionID,
                    roots,
                  })
                return context.progress(update)
              },
            })
          })
      }),
    )
  }),
})
