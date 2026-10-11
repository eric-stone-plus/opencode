import path from "path"
import { createHash } from "crypto"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { Effect, Option, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { Todo } from "./todo"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PROMPT_GOAL_REMINDER from "./prompt/goal-reminder.txt"
import PROMPT_AUTO_MODE from "./prompt/auto-mode.txt"
import PROMPT_BUILD_MODE from "./prompt/build-mode.txt"
import PROMPT_GOAL_MODE from "./prompt/goal-mode.txt"

const GOAL_REMINDER_MAX = 8000
const PLANNING_FILES = ["task_plan.md", "findings.md", "progress.md"]
const PLANNING_CONTENT_MAX = 32000
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

export type ReminderKind = "goal" | "mode" | "planning"

const key = (text: string) => createHash("sha1").update(text).digest("hex")

const goalCleared = () =>
  "<system-reminder>\nThe session goal has been cleared. Earlier goal reminders in this conversation no longer apply.\n</system-reminder>"

const goalChanged = (text: string) =>
  text.replace("<system-reminder>\n", () => "<system-reminder>\nThe session goal changed; this replaces any earlier goal reminder.\n")

const planningChanged = (text: string) =>
  text.replace(
    "<system-reminder>\n",
    () => "<system-reminder>\nThe planning state changed; this replaces any earlier planning card.\n",
  )

const planningRestored = (text: string) =>
  text.replace(
    "## Loss check\n",
    () =>
      "## Loss check\nRestored after compaction — the previous planning card is gone from context; compare this inventory with what you remember and re-record anything missing.\n",
  )

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
  const todo = yield* Todo.Service
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
      .flatMap((part) =>
        part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.command ? [part.text] : [],
      )
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

  // Standing planning-state card: re-injects the todo table and the planning
  // files under <directory>/.planning/<sessionID>/ after compaction drops them
  // from context, and the loss check names anything that vanished since the
  // previous card. The loss ledger lives in session metadata and advances only
  // when a card is actually persisted, so every loss check diffs against the
  // last card, not the last loop step.
  const todos = yield* todo.get(input.session.id)
  const planningRoot = path.join(input.session.directory, ".planning", input.session.id)
  // apply() receives session info captured once at the top of the prompt loop,
  // so input.session.metadata goes stale after the first setMetadata of the
  // turn. Re-read it: the loss ledger must reflect the last card write even
  // mid-turn, and the map written back must not clobber keys others updated
  // since the capture.
  const fresh = yield* sessions.get(input.session.id).pipe(Effect.orElseSucceed(() => input.session))
  const ledger = Option.getOrNull(decodePlanningInventory(fresh.metadata?.planning_inventory))
  const planning = yield* Effect.fn("SessionReminders.planningState")(function* () {
    const primary = yield* readPlanning(planningRoot)
    if (primary.size > 0) return { dir: planningRoot, files: primary }
    // Fallback for a renamed or manually moved directory. Only a prior planning
    // card (the ledger) proves these files are this session's, and a directory
    // named after another live session under .planning/ is never ours to claim.
    if (!ledger) return undefined
    const live = new Set<string>((yield* sessions.list()).map((item) => item.id))
    const base = path.dirname(planningRoot)
    const entries = yield* fsys.readDirectoryEntries(base).pipe(Effect.orElseSucceed((): FSUtil.DirEntry[] => []))
    let best: { dir: string; files: Map<string, PlanningFile>; mtime: number } | undefined
    for (const entry of entries) {
      if (entry.type !== "directory") continue
      if (entry.name !== input.session.id && live.has(entry.name)) continue
      const dir = path.join(base, entry.name)
      const files = yield* readPlanning(dir)
      if (files.size === 0) continue
      let mtime = 0
      const info = yield* fsys.stat(dir).pipe(Effect.orElseSucceed(() => undefined))
      if (info && Option.isSome(info.mtime)) mtime = info.mtime.value.getTime()
      // Directory mtime does not move on content edits; take the files too.
      for (const name of files.keys()) {
        const file = yield* fsys.stat(path.join(dir, name)).pipe(Effect.orElseSucceed(() => undefined))
        if (file && Option.isSome(file.mtime)) mtime = Math.max(mtime, file.mtime.value.getTime())
      }
      if (!best || mtime > best.mtime) best = { dir, files, mtime }
    }
    return best
  })()
  const body = planningBody({
    dir: planning?.dir ?? planningRoot,
    todos,
    files: planning?.files ?? new Map<string, PlanningFile>(),
    losses: planningLosses(ledger, todos, planning?.files ?? new Map<string, PlanningFile>()),
  })
  const previous = latest("planning")
  // An empty state is a neutral card: it exists only to supersede an earlier
  // planning card. The dedupe key covers the state sections (header, todos,
  // planning files); the loss check is a diff against the ledger and the two
  // notices below are context notes, so an unchanged inventory never rewrites
  // the card even though the diff view flips once the ledger advances.
  if (todos.length > 0 || planning !== undefined || previous) {
    if (previous?.key !== body.key) {
      const text = previous ? planningChanged(body.text) : ledger ? planningRestored(body.text) : body.text
      yield* persist(text, { reminder: "planning", key: body.key })
      yield* sessions.setMetadata({
        sessionID: userMessage.info.sessionID,
        metadata: {
          ...fresh.metadata,
          planning_inventory: JSON.stringify(planningInventory(todos, planning?.files)),
        },
      })
    }
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

type PlanningFile = { content: string; bytes: number; sha: string }

const readPlanning = Effect.fn("SessionReminders.readPlanning")(function* (dir: string) {
  const fsys = yield* FSUtil.Service
  const found = new Map<string, PlanningFile>()
  for (const name of PLANNING_FILES) {
    const content = yield* fsys.readFileStringSafe(path.join(dir, name)).pipe(Effect.orElseSucceed(() => undefined))
    if (content === undefined) continue
    const bytes = Buffer.from(content, "utf8")
    found.set(name, { content, bytes: bytes.length, sha: createHash("sha256").update(bytes).digest("hex") })
  }
  return found
})

const PlanningInventory = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String, priority: Schema.String })),
  files: Schema.Record(Schema.String, Schema.Struct({ bytes: Schema.Number, sha: Schema.String })),
})

const decodePlanningInventory = Schema.decodeUnknownOption(Schema.fromJsonString(PlanningInventory))

function planningInventory(todos: readonly Todo.Info[], files: ReadonlyMap<string, PlanningFile> | undefined) {
  return {
    todos: todos.map((todo) => ({ content: todo.content, status: todo.status, priority: todo.priority })),
    files: Object.fromEntries(
      [...(files ?? new Map<string, PlanningFile>())].map(([name, file]) => [name, { bytes: file.bytes, sha: file.sha }]),
    ),
  }
}

// A loss is a ledger todo that is gone without being completed or cancelled,
// or a ledger planning file that is gone; status changes, reordering and file
// content updates are not losses.
function planningLosses(
  ledger: Schema.Schema.Type<typeof PlanningInventory> | null,
  todos: readonly Todo.Info[],
  files: ReadonlyMap<string, PlanningFile>,
): string[] {
  if (!ledger) return []
  return [
    ...ledger.todos
      .filter(
        (todo) =>
          todo.status !== "completed" &&
          todo.status !== "cancelled" &&
          !todos.some((current) => current.content === todo.content),
      )
      .map((todo) => `todo "${todo.content}" (was ${todo.status})`),
    ...Object.keys(ledger.files)
      .filter((name) => !files.has(name))
      .map((name) => `planning file ${name}`),
  ]
}

function planningBody(input: {
  dir: string
  todos: readonly Todo.Info[]
  files: ReadonlyMap<string, PlanningFile>
  losses: readonly string[]
}) {
  const count = (status: string) => input.todos.filter((todo) => todo.status === status).length
  const header = `Planning-state card: the current todos and planning files for this session. Planning directory: ${input.dir}.`
  const todoList = input.todos.map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}`).join("\n") || "(none)"
  const filesSection = input.files.size
    ? `## Planning files\n${planningSections(input.files)}`
    : `No planning files exist at ${input.dir}.`
  const lossCheck = input.losses.length
    ? `LOST since the last planning card:\n${input.losses.map((loss) => `- ${loss}`).join("\n")}`
    : `clean — ${input.todos.length} todos (${count("pending")} pending / ${count("in_progress")} in_progress / ${count("completed")} completed / ${count("cancelled")} cancelled); planning files: ${[...input.files].map(([name, file]) => `${name} (${file.bytes} bytes, ${file.sha.slice(0, 8)})`).join(", ") || "(none)"}`
  return {
    text: `<system-reminder>\n${header}\n\n## Loss check\n${lossCheck}\n\n## Todo list\n${todoList}\n\n${filesSection}\n</system-reminder>`,
    key: key([header, todoList, filesSection].join("\n")),
  }
}

function planningSections(files: ReadonlyMap<string, PlanningFile>) {
  const sections: string[] = []
  let budget = PLANNING_CONTENT_MAX
  for (const [name, file] of files) {
    sections.push(`### ${name} — ${file.bytes} bytes, sha256 ${file.sha.slice(0, 8)}`)
    if (budget <= 0) {
      sections.push("(truncated)")
      continue
    }
    if (file.content.length <= budget) {
      sections.push(file.content)
      budget -= file.content.length
      continue
    }
    let cut = budget
    // Do not slice between the halves of a surrogate pair.
    if (cut > 0 && file.content.charCodeAt(cut) >= 0xdc00 && file.content.charCodeAt(cut) <= 0xdfff) cut -= 1
    sections.push(`${file.content.slice(0, cut)}\n(truncated)`)
    budget = 0
  }
  return sections.join("\n")
}

export * as SessionReminders from "./reminders"
