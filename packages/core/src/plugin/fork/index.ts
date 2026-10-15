export * as ForkPlugin from "./index.js"

import { ForkInstructionsPlugin } from "./instructions.js"
import { ForkModesPlugin } from "./modes.js"
import { ForkAutonomyPlugin } from "./autonomy.js"
import { ForkPricingPlugin } from "./pricing.js"
import { ForkChildAuthorityPlugin } from "./child-authority.js"
import { ForkGuardPlugin } from "./guard.js"
import { ForkEnvelopePlugin } from "./envelope.js"

/** Registered after the config plugins, so their transforms see the agents and instructions config defined. */
export const post = [
  ForkInstructionsPlugin.Plugin,
  ForkModesPlugin.Plugin,
  ForkAutonomyPlugin.Plugin,
  ForkPricingPlugin.Plugin,
  ForkChildAuthorityPlugin.Plugin,
  ForkEnvelopePlugin.Plugin,
  // Last on purpose: permission hooks run in registration order over one shared event, so the guard
  // observes the final effect every other hook produced. See the header of guard.ts for the invariants.
  ForkGuardPlugin.Plugin,
] as const
