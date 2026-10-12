export * as ForkPlugin from "./index.js"

import { ForkInstructionsPlugin } from "./instructions.js"
import { ForkModesPlugin } from "./modes.js"
import { ForkPlanPlugin } from "./plan.js"
import { ForkAutonomyPlugin } from "./autonomy.js"

/** Takes the place of `opencode.plan`: the same plan agent, with the fork's reminders instead of upstream's. */
export const plan = ForkPlanPlugin.Plugin

/** Registered after the config plugins, so their transforms see the agents and instructions config defined. */
export const post = [ForkInstructionsPlugin.Plugin, ForkModesPlugin.Plugin, ForkAutonomyPlugin.Plugin] as const
