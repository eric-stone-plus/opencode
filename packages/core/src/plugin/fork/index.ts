export * as ForkPlugin from "./index.js"

import { ForkInstructionsPlugin } from "./instructions.js"
import { ForkModesPlugin } from "./modes.js"
import { ForkAutonomyPlugin } from "./autonomy.js"
import { ForkPricingPlugin } from "./pricing.js"
import { ForkChildAuthorityPlugin } from "./child-authority.js"

/** Registered after the config plugins, so their transforms see the agents and instructions config defined. */
export const post = [
  ForkInstructionsPlugin.Plugin,
  ForkModesPlugin.Plugin,
  ForkAutonomyPlugin.Plugin,
  ForkPricingPlugin.Plugin,
  ForkChildAuthorityPlugin.Plugin,
] as const
