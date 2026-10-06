import path from "path"
import { createHash } from "crypto"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PROMPT_GOAL_REMINDER from "./prompt/goal-reminder.txt"
import PROMPT_AUTO_MODE from "./prompt/auto-mode.txt"
import PROMPT_BUILD_MODE from "./prompt/build-mode.txt"
import PROMPT_GOAL_MODE from "./prompt/goal-mode.txt"

const GOAL_REMINDER_MAX = 8000
const INTERNAL_AGENTS = new Set(["compaction", "title", "summary"])

// Standing mode cards: one per primary profile (auto / goal / build; plan uses
// PROMPT_PLAN or PLAN_MODE) so the model is told which profile it is under and
// that stale plan-mode claims in history do not apply.
//
// Standing reminders (mode card, goal reminder) are persisted on the user
// message where they are first injected and never move afterwards: history
// stays byte-identical across turns so the provider prompt cache keeps hitting.
// A later user message gets a new card only when the desired content differs
// from the latest card of the same kind still in the model context (mode switch,
// goal edited / cleared, or the old card was compacted away).
const STANDING_MODE: Record<string, string> = {
  auto: PROMPT_AUTO_MODE,
  goal: PROMPT_GOAL_MODE,
  build: PROMPT_BUILD_MODE,
}

export type ReminderKind = "goal" | "mode"

const key = (text: string) => createHash("sha1").update(text).digest("hex")

const goalCleared = () =>
  "<system-reminder>\nThe session goal has been cleared. Earlier goal reminders in this conversation no longer apply.\n</system-reminder>"

const goalChanged = (text: string) =>
  text.replace("<system-reminder>\n", () => "<system-reminder>\nThe session goal changed; this replaces any earlier goal reminder.\n")

const modeOther = (agent: string) =>
  `<system-reminder>\nOperational mode: ${agent}. Earlier operational-mode reminders in this conversation are superseded and no longer apply.\n</system-reminder>`

const cardOf = (part: SessionV1.Part) =>
  part.type === "text" && part.synthetic && typeof part.metadata?.reminder === "string"
    ? { kind: part.metadata.reminder as ReminderKind, key: String(part.metadata.key) }
    : undefined

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  /** Names of subagent-mode agents; their (subtask) turns never count as the preceding turn. */
  subagents?: ReadonlySet<string>
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Latest standing card of `kind` in the model context (array order is the
  // order the model reads; compacted-away cards are not in `messages`).
  const latest = (kind: ReminderKind) => {
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const parts = input.messages[i]!.parts
      for (let j = parts.length - 1; j >= 0; j--) {
        const card = cardOf(parts[j]!)
        if (card?.kind === kind) return card
      }
    }
  }

  const persist = Effect.fn("SessionReminders.persist")(function* (text: string, metadata?: Record<string, string>) {
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
      ...(metadata ? { metadata } : {}),
    })
    userMessage.parts.push(part)
  })

  // A `neutral` card (no goal / no standing card for this agent) is only
  // written when it has to supersede an earlier card of its kind. `settle`
  // pins the first card written on this user message for the rest of the turn
  // (the mode is fixed per user message; a plan file appearing mid-turn is not
  // worth a cache rewrite). The goal is not settled: an edit mid-turn appends
  // one superseding card so a long-running turn never steers by a stale goal.
  const standing = Effect.fn("SessionReminders.standing")(function* (
    kind: ReminderKind,
    desired: { text: string; neutral?: boolean },
    options: { wrap?: (text: string) => string; settle?: boolean } = {},
  ) {
    if (options.settle && userMessage.parts.some((part) => cardOf(part)?.kind === kind)) return
    const previous = latest(kind)
    const next = key(desired.text)
    if (previous?.key === next) return
    if (desired.neutral && !previous) return
    const text = previous && !desired.neutral && options.wrap ? options.wrap(desired.text) : desired.text
    yield* persist(text, { reminder: kind, key: next })
  })

  const ctx = yield* InstanceState.context
  const events = yield* EventV2Bridge.Service
  const goalPath = Session.goal(input.session, ctx)
  // Goal mode owns the objective: the session goal used to be written by the
  // /goal command, which is gone. Entering goal mode with no goal file yet
  // seeds it from the user's own message, so the goal reminder below always has
  // something to state; later messages steer without rewriting it.
  const goalExists = yield* fsys.existsSafe(goalPath)
  if (!goalExists && input.agent.name === "goal") {
    const objective = userMessage.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim()
    if (objective) {
      yield* fsys.writeWithDirs(goalPath, objective).pipe(Effect.catch(Effect.die))
      // Publish what the old /goal command published: the TUI footer (⎇) and
      // the SDK both update from goal.updated; without it a goal seeded
      // mid-session stays invisible until the next hydration.
      yield* events.publish(SessionGoal.Event.Updated, {
        sessionID: userMessage.info.sessionID,
        text: objective,
        path: goalPath,
      })
    }
  }
  const goal = (yield* fsys.readFileStringSafe(goalPath).pipe(Effect.orElseSucceed(() => undefined)))?.trim()
  if (goal) {
    const text = goal.length > GOAL_REMINDER_MAX ? goal.slice(0, GOAL_REMINDER_MAX) + "\n(truncated)" : goal
    yield* standing(
      "goal",
      { text: PROMPT_GOAL_REMINDER.replace("${goal}", () => text).replace("${path}", () => goalPath) },
      { wrap: goalChanged },
    )
  } else {
    yield* standing("goal", { text: goalCleared(), neutral: true })
  }

  // Standing mode card for the active profile.
  if (input.agent.name === "plan") {
    if (flags.experimentalPlanMode) {
      const plan = Session.plan(input.session, ctx)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      yield* standing(
        "mode",
        {
          text: PLAN_MODE.replace("${planInfo}", () =>
            exists
              ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
              : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
          ),
        },
        { settle: true },
      )
    } else {
      yield* standing("mode", { text: PROMPT_PLAN }, { settle: true })
    }
    return input.messages
  }

  const card = STANDING_MODE[input.agent.name]
  yield* standing("mode", card ? { text: card } : { text: modeOther(input.agent.name), neutral: true }, { settle: true })

  // Transition card: fires only when the immediately preceding assistant turn
  // ran under plan and the current profile is not plan — any landing profile
  // (auto / goal / build), not just build. `findLast` keeps this transition-once
  // per landing; the old `some(...)` check re-fired on every later turn.
  // Internal agents (a compaction between the plan turn and the switch) and
  // subagents (a subtask command's assistant message in this session) do not
  // count as the preceding turn.
  const previousAgent = input.messages.findLast(
    (msg) =>
      msg.info.role === "assistant" &&
      !INTERNAL_AGENTS.has(msg.info.agent) &&
      !input.subagents?.has(msg.info.agent),
  )?.info.agent
  if (previousAgent !== "plan") return input.messages

  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  const text =
    exists && flags.experimentalPlanMode
      ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
      : BUILD_SWITCH
  // Transition cards are persisted so the mode change stays visible in the
  // transcript; content-matched dedupe makes the injection once-per-message
  // even though apply() runs once per loop step against DB-reloaded messages.
  if (userMessage.parts.some((part) => part.type === "text" && part.text === text)) return input.messages
  yield* persist(text)
  return input.messages
})

export * as SessionReminders from "./reminders"
