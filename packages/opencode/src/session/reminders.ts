import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
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
// PROMPT_PLAN or PLAN_MODE), injected every turn so the model is told which
// profile it is under and that stale plan-mode claims in history do not apply.
// In-memory only — never persisted — so they cannot accumulate or go stale in
// the database across turns.
const STANDING_MODE: Record<string, string> = {
  auto: PROMPT_AUTO_MODE,
  goal: PROMPT_GOAL_MODE,
  build: PROMPT_BUILD_MODE,
}

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

  // In-memory synthetic part: re-derived every turn from the current profile,
  // never written to the transcript.
  const pushStanding = (text: string) => {
    if (userMessage.parts.some((part) => part.type === "text" && part.text === text)) return
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })
  }

  const ctx = yield* InstanceState.context
  const goalPath = Session.goal(input.session, ctx)
  const goal = (yield* fsys.readFileStringSafe(goalPath).pipe(Effect.orElseSucceed(() => undefined)))?.trim()
  if (goal) {
    const text = goal.length > GOAL_REMINDER_MAX ? goal.slice(0, GOAL_REMINDER_MAX) + "\n(truncated)" : goal
    pushStanding(PROMPT_GOAL_REMINDER.replace("${goal}", () => text).replace("${path}", () => goalPath))
  }

  // Standing mode card for the active profile.
  if (input.agent.name === "plan") {
    if (flags.experimentalPlanMode) {
      const plan = Session.plan(input.session, ctx)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      pushStanding(
        PLAN_MODE.replace("${planInfo}", () =>
          exists
            ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
            : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
        ),
      )
    } else {
      pushStanding(PROMPT_PLAN)
    }
    return input.messages
  }

  const standing = STANDING_MODE[input.agent.name]
  if (standing) pushStanding(standing)

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
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
