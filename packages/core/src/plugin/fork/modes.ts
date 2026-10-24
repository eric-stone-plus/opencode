export * as ForkModesPlugin from "./modes.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { SessionEvent } from "@opencode/schema/session-event"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Option, Stream } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { ForkCards } from "./cards.js"
import { ForkFiles } from "./files.js"
import { PROFILE_RULES } from "./profiles.js"
import AUTO from "./mode/auto.txt"
import GOAL from "./mode/goal.txt"
import GOAL_REMINDER from "./mode/goal-reminder.txt"

const GOAL_REMINDER_MAX = 8000

// Standing mode card per primary profile, presented on every request while that profile is active.
// Only auto and goal remain: build and plan are disabled in the seat config (owner call 2026-10-14).
const STANDING: Partial<Record<string, string>> = { auto: AUTO.trim(), goal: GOAL.trim() }

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
    const sessions = yield* Session.Service
    const cards = ForkCards.make()
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.agent.reload())

    yield* ctx.agent.transform((editor) => {
      const declared = loaded.entries.flatMap((entry) =>
        entry.type === "document" ? Object.keys(entry.info.agents ?? {}) : [],
      )
      order(editor, declared)
      // Config-declared profiles are created by the config plugin in `post`, after ForkProfilesPlugin
      // ran. If that config did not set `default_agent`, select auto here, where both the built-in and
      // the config-created agents are visible; otherwise a config that declares auto but not goal
      // would fall back to goal because goal was inserted first.
      if (Config.latest(loaded.entries, "default_agent") === undefined) {
        const preferred = (["auto", "goal"] as const).find((id) => {
          const agent = editor.get(id)
          return agent !== undefined && agent.mode !== "subagent" && !agent.hidden
        })
        if (preferred !== undefined) editor.default(preferred)
      }
      // The config plugin has already pushed the operator's global permission rules. Re-assert the
      // built-in profiles' no-interrupt surface after them: a global `permission: "allow"` would
      // otherwise land last and re-open the question tool for a profile that must never ask.
      // This is unconditional, even when a document declares its own block: a partial block (say,
      // only `todowrite`) must not drop the question/seat floors, and the duplicate denies are
      // harmless because every floor rule denies.
      for (const id of ["auto", "goal"] as const) {
        if (!editor.get(id)) continue
        editor.update(id, (agent) => agent.permissions.push(...PROFILE_RULES))
      }
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
      // The file stays the source of truth; session metadata mirrors it so any client can read it.
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
        const wanted: string[] = []
        // The standing card keys on the session's agent, not on parentage: a child session that resolves to auto or
        // goal keeps its profile framing, while a child running as general/explore gets none (no STANDING entry).
        // New child sessions can neither be assigned nor run as a primary agent (fork/child-agent.ts), so the
        // first case is reachable only for rows that predate that guard.
        const card = STANDING[event.agent]
        if (card !== undefined) wanted.push(card)
        // The goal, unlike the card, belongs to the top-level session that owns it, so child sessions never carry it.
        if (!session.parentID)
          wanted.push(...(yield* goal(session, event.agent).pipe(isolate("failed to resolve the session goal", []))))
        yield* cards.apply(event, wanted)
      }).pipe(isolate("failed to apply fork mode cards", undefined)),
    )

    // A goal belongs to its session, so it goes away with it.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event): event is SessionEvent.Deleted => event.type === "session.deleted"),
      Stream.runForEach((event) =>
        fs.remove(ForkFiles.goal(global, event.data.sessionID), { force: true }).pipe(Effect.ignore),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
