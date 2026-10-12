export * as ForkModesPlugin from "./modes.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { SessionEvent } from "@opencode/schema/session-event"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Option, Stream } from "effect"
import path from "path"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Location } from "../../location.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { ForkCards } from "./cards.js"
import { ForkFiles } from "./files.js"
import AUTO from "./mode/auto.txt"
import BUILD from "./mode/build.txt"
import GOAL from "./mode/goal.txt"
import GOAL_REMINDER from "./mode/goal-reminder.txt"
import PLAN from "./mode/plan.txt"
import TRANSITION from "./mode/transition.txt"

const GOAL_REMINDER_MAX = 8000

// Standing mode card per primary profile, presented on every request while that profile is active.
const STANDING: Partial<Record<string, string>> = { auto: AUTO.trim(), goal: GOAL.trim(), build: BUILD.trim() }

const planCard = (file: string) => PLAN.trim().replace("${plan}", () => file)

const transitionCard = (file: string, exists: boolean) =>
  exists
    ? `${TRANSITION.trim()}\n\nA plan file exists at ${file}. You should execute on the plan defined within it`
    : TRANSITION.trim()

const goalCard = (goal: string, file: string) =>
  GOAL_REMINDER.trim()
    .replace("${goal}", () => (goal.length > GOAL_REMINDER_MAX ? `${goal.slice(0, GOAL_REMINDER_MAX)}\n(truncated)` : goal))
    .replace("${path}", () => file)

/** Configured agents keep their declaration order after the default, so Tab cycles the profiles as written. */
function order(editor: AgentEditor, declared: ReadonlyArray<string>) {
  const present: string[] = editor.list().map((agent) => agent.id)
  const first = [...new Set(declared)].filter((id) => present.includes(id))
  // Map insertion order is list order: re-adding the declared agents first and the rest after puts them in front.
  for (const id of [...first, ...present.filter((id) => !first.includes(id))]) {
    const saved = editor.get(id)
    if (!saved) continue
    editor.remove(id)
    editor.update(id, (agent) => Object.assign(agent, saved))
  }
}

/** A failing section must not fail the model request or take the other cards down with it. */
const isolate = <A>(label: string, fallback: A) =>
  Effect.catchCause((cause) => Effect.logWarning(label, { cause }).pipe(Effect.as(fallback)))

export const Plugin = define({
  id: "fork.modes",
  effect: Effect.fn("ForkModesPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const sessions = yield* Session.Service
    const cards = ForkCards.make()
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.agent.reload())

    yield* ctx.agent.transform((editor) => {
      // The plan agent may write its plan file. Rules are matched against the path the file tools report: relative
      // to the location when the file is inside it, absolute otherwise. This runs after config, which re-asserts
      // `edit: deny` for the plan agent and would otherwise win.
      const plans = path.dirname(ForkFiles.plan(global, ""))
      const relative = path.relative(location.directory, plans).replaceAll("\\", "/")
      // update creates a missing agent, and a user who disabled the plan agent must not get it back.
      if (editor.get("plan"))
        editor.update("plan", (agent) =>
          agent.permissions.push(
            ...[`${plans}/*`, `${relative}/*`].map((resource) => ({ action: "edit", resource, effect: "allow" as const })),
          ),
        )
      order(
        editor,
        loaded.entries.flatMap((entry) => (entry.type === "document" ? Object.keys(entry.info.agents ?? {}) : [])),
      )
    })

    const goal = Effect.fn("ForkModesPlugin.goal")(function* (session: SessionSchema.Info, agent: string) {
      const file = ForkFiles.goal(global, session.id)
      // A failed read says nothing about the goal; leave history and the mirror alone rather than retire it.
      const read = yield* fs.readFileStringSafe(file).pipe(Effect.option)
      if (Option.isNone(read)) return []
      // Goal mode owns its objective: the first message in goal mode becomes the goal, later ones steer it.
      // A file that exists but is empty was cleared on purpose and is not seeded again.
      const [last] =
        read.value === undefined && agent === "goal"
          ? yield* sessions.messages({ sessionID: session.id, limit: 1, order: "desc", type: "user" })
          : []
      // A slash command expands into template text, which is a procedure for the model rather than an objective.
      const objective = last?.type === "user" && last.metadata?.command === undefined ? last.text.trim() : ""
      if (objective !== "") yield* fs.writeWithDirs(file, `${objective}\n`)
      const text = (objective === "" ? read.value : objective)?.trim() ?? ""
      // Clients render the goal from session metadata, so the file stays the source of truth and metadata its mirror.
      const mirror = text === "" ? undefined : { text, path: file }
      if (JSON.stringify(session.metadata?.goal) !== JSON.stringify(mirror)) {
        const rest = Object.entries(session.metadata ?? {}).filter(([key]) => key !== "goal")
        yield* ctx.session.update({
          sessionID: session.id,
          metadata: { ...Object.fromEntries(rest), ...(mirror ? { goal: mirror } : {}) },
        })
      }
      // An empty goal contributes nothing: system parts are rebuilt per request, so no retirement card is needed.
      return text === "" ? [] : [goalCard(text, file)]
    })

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID })
        const plan = event.agent === "plan"
        const file = ForkFiles.plan(global, event.sessionID)
        const wanted: string[] = []
        if (plan) {
          yield* fs.ensureDir(path.dirname(file)).pipe(Effect.ignore)
          wanted.push(planCard(file))
        } else {
          const card = STANDING[event.agent]
          if (card !== undefined) wanted.push(card)
          // Plan to anything else: the first request after the switch carries the transition card, once per landing.
          const [previous] = yield* sessions.messages({
            sessionID: event.sessionID,
            limit: 1,
            order: "desc",
            type: "assistant",
          })
          if (previous?.type === "assistant" && previous.agent === "plan")
            wanted.push(transitionCard(file, yield* fs.existsSafe(file)))
        }
        // Subagent sessions never carry the goal; it belongs to the top-level session that owns it.
        if (!session.parentID)
          wanted.push(...(yield* goal(session, event.agent).pipe(isolate("failed to resolve the session goal", []))))
        yield* cards.apply(event, wanted)
      }).pipe(isolate("failed to apply fork mode cards", undefined)),
    )

    // A goal belongs to its session, so it goes away with it. The plan file is a document the user may keep.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event): event is SessionEvent.Deleted => event.type === "session.deleted"),
      Stream.runForEach((event) =>
        fs.remove(ForkFiles.goal(global, event.data.sessionID), { force: true }).pipe(Effect.ignore),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
