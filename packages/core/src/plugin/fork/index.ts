export * as ForkPlugin from "./index.js"

import { ForkInstructionsPlugin } from "./instructions.js"
import { ForkModesPlugin } from "./modes.js"
import { ForkProfilesPlugin } from "./profiles.js"
import { ForkAutonomyPlugin } from "./autonomy.js"
import { ForkPricingPlugin } from "./pricing.js"
import { ForkDeepSeekBaseURLPlugin } from "./base-url.js"
import { ForkModelNamesPlugin } from "./model-names.js"
import { ForkSearchPlugin } from "./search.js"
import { ForkWebFetchPlugin } from "./webfetch.js"
import { ForkChildAuthorityPlugin } from "./child-authority.js"
import { ForkGuardPlugin } from "./guard.js"
import { ForkWriteScopePlugin } from "./write-scope.js"
import { ForkSubagentInterruptPlugin } from "./interrupt.js"
import { ForkEnvelopePlugin } from "./envelope.js"

/**
 * Registered with the other built-in creators, before the config plugins: the config plugin applies
 * the operator's agent fields and permissions on top, and re-creates any declared agent this
 * transform removed. `build`/`plan` removal therefore has to happen here, not after config.
 */
export const pre = [ForkProfilesPlugin.Plugin] as const

/** Registered after the config plugins, so their transforms see the agents and instructions config defined. */
export const post = [
  ForkInstructionsPlugin.Plugin,
  ForkModesPlugin.Plugin,
  ForkAutonomyPlugin.Plugin,
  ForkPricingPlugin.Plugin,
  ForkDeepSeekBaseURLPlugin.Plugin,
  ForkModelNamesPlugin.Plugin,
  ForkSearchPlugin.Plugin,
  ForkWebFetchPlugin.Plugin,
  ForkChildAuthorityPlugin.Plugin,
  ForkEnvelopePlugin.Plugin,
  ForkWriteScopePlugin.Plugin,
  ForkSubagentInterruptPlugin.Plugin,
  // Last on purpose: permission hooks run in registration order over one shared event, so the guard
  // observes the final effect every other hook produced. See the header of guard.ts for the invariants.
  ForkGuardPlugin.Plugin,
] as const
