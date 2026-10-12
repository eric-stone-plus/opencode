export * as ForkAutonomyPlugin from "./autonomy.js"

import { SystemPart } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../../agent.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Skill } from "../../skill.js"
import CONTRACT from "./autonomy.txt"
import REMINDER from "./autonomy-reminder.txt"

/**
 * The skill autonomy contract: when the session denies the `question` tool, skills written for an
 * agent that can stop and ask a human have that one part replaced. The gate reads the same merged
 * ruleset the tool snapshot and the permission service use — agent rules plus session rules, session
 * last — so `opencode run` (which denies `question` at session level) gets the contract too.
 */
export const Plugin = define({
  id: "fork.autonomy",
  effect: Effect.fn("ForkAutonomyPlugin")(function* (ctx) {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const skills = yield* Skill.Service

    const ruleset = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      const agent = yield* agents.get(agentID)
      return Permission.merge(agent?.permissions ?? [], session.permissions ?? [])
    })

    const questionDenied = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID: Agent.ID) {
      return Permission.evaluate("question", "*", yield* ruleset(sessionID, agentID)).effect === "deny"
    })

    /** A failing section must not fail the model request or block the tool result. */
    const isolate = <A>(label: string, fallback: A) =>
      Effect.catchCause((cause) => Effect.logWarning(label, { cause }).pipe(Effect.as(fallback)))

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (!(yield* questionDenied(event.sessionID, event.agent))) return
        const available = Skill.available(yield* skills.list(), yield* ruleset(event.sessionID, event.agent))
        if (available.length === 0) return
        event.system.push(SystemPart.make(CONTRACT.trim()))
      }).pipe(isolate("failed to apply the skill autonomy contract", undefined)),
    )

    // Appended to each loaded skill, so the rule sits beside the instructions it overrides.
    // Deliberately short: skill tool output is exempt from compaction pruning, so every copy is permanent.
    const appendReminder = Effect.fnUntraced(function* (event: {
      readonly tool: string
      readonly sessionID: SessionSchema.ID
      readonly agent: Agent.ID
      result: { content?: unknown; metadata?: unknown }
    }) {
      if (event.tool !== "skill") return
      if (!(yield* questionDenied(event.sessionID, event.agent))) return
      const reminder = REMINDER.trim()
      const content = event.result.content
      if (content === undefined) {
        event.result.content = reminder
        return
      }
      if (typeof content === "string") {
        event.result.content = `${content}\n\n${reminder}`
        return
      }
      if (!Array.isArray(content)) return
      const last = content.at(-1) as { type?: string; text?: string } | undefined
      event.result.content =
        last?.type === "text" && typeof last.text === "string"
          ? [...content.slice(0, -1), { ...last, text: `${last.text}\n\n${reminder}` }]
          : [...content, { type: "text", text: reminder }]
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return Effect.void
      return appendReminder(event).pipe(isolate("failed to append the skill autonomy reminder", undefined))
    })
  }),
})
