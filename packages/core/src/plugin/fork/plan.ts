export * as ForkPlanPlugin from "./plan.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { PlanPlugin } from "../plan.js"

/**
 * Replaces `opencode.plan` in the internal plugin list. The upstream plugin keeps defining the plan agent and
 * rewriting blocked-edit errors, but its Plan mode reminders tell the model to discuss the plan in conversation
 * and to leave only on a manual agent switch, which contradicts the plan-file workflow and `plan_exit`. Its
 * context hook and event subscription are dropped here; `fork.modes` owns the reminders instead.
 */
export const Plugin = define({
  id: PlanPlugin.Plugin.id,
  effect: (ctx) =>
    PlanPlugin.Plugin.effect({
      ...ctx,
      event: { subscribe: () => Stream.empty },
      session: {
        ...ctx.session,
        hook: (name, callback, options) =>
          name === "context" ? Effect.succeed({ dispose: Effect.void }) : ctx.session.hook(name, callback, options),
      },
    }),
})
