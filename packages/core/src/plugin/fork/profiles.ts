export * as ForkProfilesPlugin from "./profiles.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Effect } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import AUTO_CARD from "../../../../../bootstrap/agent/auto.md" with { type: "text" }
import GOAL_CARD from "../../../../../bootstrap/agent/goal.md" with { type: "text" }

/** The managed card body is the profile's system prompt; only the frontmatter is installer metadata. */
function cardBody(card: string) {
  const end = card.indexOf("\n---", 4)
  return (end === -1 ? card : card.slice(end + 4)).trim()
}

/**
 * The fork ships two primary profiles: auto (default) and goal. Their full definitions live in the
 * seat config (`opencode.jsonc` + the managed cards), but a fresh clone has neither: the global
 * config does not exist yet and project config is closed by the trust gate. Upstream's built-in
 * `build`/`plan` would then be the only primaries, so a clone would start in Build/Plan instead of
 * Auto/Goal.
 *
 * This plugin makes the two profiles part of the binary: it seeds `auto`/`goal` (even when a
 * document declares them, so a partial declaration layers on the profile instead of replacing it),
 * removes the upstream primaries they replace unless a document explicitly restores them, and
 * selects `auto` when no `default_agent` names a surviving profile. Config stays authoritative: a
 * declared agent, a disabled agent, and an explicit default naming a surviving agent all win; a
 * default naming a removed upstream primary falls back to the next selectable profile.
 */
const PROFILES = {
  auto: {
    description:
      "Auto mode. Fast, light problem-solving: execute directly, verify with the work's own checks, report terse. Never asks, never blocks.",
    color: "#5c9cf5",
    system: cardBody(AUTO_CARD),
  },
  goal: {
    description:
      "Goal mode. Every message steers one session goal to a flawless delivery closure (adversarial swarm playbook + closure checklist); discussion follows the user's input language and the report is in English.",
    color: "#e06c75",
    system: cardBody(GOAL_CARD),
  },
} as const

const UPSTREAM_PRIMARIES = ["build", "plan"] as const

/**
 * The no-interrupt surface every profile carries. `question` is denied so a profile never stops to
 * ask, and both seat resource forms are denied so a profile cannot rewrite the agent's own brain.
 * Exported because `ForkModesPlugin` re-asserts these after the config plugin: a global
 * `permission: "allow"` would otherwise land last and re-open the question tool.
 */
export const PROFILE_RULES = [
  { action: "question", resource: "*", effect: "deny" },
  { action: "edit", resource: "~/.config/opencode/*", effect: "deny" },
  { action: "edit", resource: ".config/opencode/*", effect: "deny" },
  // External files resolve to an absolute resource (`FileAccess.resolve`), which neither the
  // tilde nor the location-relative form matches. `*` spans `/`, so this covers nested seat files.
  { action: "edit", resource: "**/.config/opencode/*", effect: "deny" },
] as const

export const Plugin = define({
  id: "fork.profiles",
  effect: Effect.fn("ForkProfilesPlugin")(function* (ctx) {
    const config = yield* Config.Service
    // Read through the observer so a config edit after startup re-runs the transform with the new
    // declarations; capturing the entries at activation would freeze the first snapshot.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.agent.reload())

    yield* ctx.agent.transform((editor) => {
      const entries = loaded.entries
      const documents = entries.filter((entry): entry is Document => entry.type === "document")
      const declared = new Set(documents.flatMap((document) => Object.keys(document.info.agents ?? {})))
      const disabled = new Set(
        documents.flatMap((document) =>
          Object.entries(document.info.agents ?? {})
            .filter(([, agent]) => agent.disabled)
            .map(([id]) => id),
        ),
      )
      const configuredDefault = Config.latest(entries, "default_agent")

      // Upstream primaries the fork replaced. A document that declares one keeps it: the config
      // plugin runs after this transform and re-creates declared agents, so an explicit opt-in wins.
      for (const id of UPSTREAM_PRIMARIES) {
        if (!declared.has(id)) editor.remove(Agent.ID.make(id))
      }

      for (const [id, profile] of Object.entries(PROFILES)) {
        if (disabled.has(id)) continue
        // Seed the built-in profile even when a document declares it: the config plugin runs later
        // and overlays only the fields the declaration names, so `agent.auto: { color }` keeps the
        // card body and the no-interrupt floor instead of replacing the profile with a bare agent.
        editor.update(Agent.ID.make(id), (agent) => {
          agent.description = profile.description
          agent.mode = "primary"
          agent.color = profile.color
          agent.system = profile.system
          agent.permissions.push(...PROFILE_RULES)
        })
      }

      // No configured default: auto is the fork default. If auto is declared but not created yet
      // (ConfigAgentPlugin runs in `post`), leave the selection to ForkModesPlugin, which sees the
      // final list; setting goal here would briefly point the default at the wrong profile.
      if (configuredDefault === undefined) {
        if (editor.get(Agent.ID.make("auto"))) editor.default(Agent.ID.make("auto"))
        else if (disabled.has("auto") && editor.get(Agent.ID.make("goal"))) editor.default(Agent.ID.make("goal"))
      }
    })
  }),
})
