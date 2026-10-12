export * as ForkPlugin from "./index.js"

import { ForkInstructionsPlugin } from "./instructions.js"
import { ForkModesPlugin } from "./modes.js"
import { ForkPlanPlugin } from "./plan.js"

/** Takes the place of `opencode.plan`: the same plan agent, with the fork's reminders instead of upstream's. */
export const plan = ForkPlanPlugin.Plugin

/** Registered after the config plugins, so their transforms see the agents and instructions config defined. */
export const post = [ForkInstructionsPlugin.Plugin] as const

/**
 * Standing mode cards and goal seeding. Not registered yet: it persists its reminders through `ctx.session.synthetic`,
 * which makes subagent completion notices disappear from the parent context (test/config/command-subagent.test.ts).
 * Register it again once the cards are injected as system parts instead.
 */
export const modes = ForkModesPlugin.Plugin
