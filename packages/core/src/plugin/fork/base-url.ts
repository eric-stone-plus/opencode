export * as ForkDeepSeekBaseURLPlugin from "./base-url.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Scope } from "effect"
import { BASE_URL, DEEPSEEK } from "../../deepseek.js"

/**
 * Pins the native DeepSeek chat endpoint at the source level.
 *
 * The config's provider block carries the registry value, but a project config
 * can override `baseURL`. That must not send chat traffic to the
 * Anthropic-compatible surface (`/anthropic`) or another host. The tools and
 * model metadata already use `BASE_URL` directly; this closes the chat path.
 */
export const Plugin = define<Scope.Scope>({
  id: "fork.deepseek.base-url",
  effect: (ctx) =>
    ctx.provider.transform((editor) => {
      if (!editor.get(DEEPSEEK)) return
      editor.update(DEEPSEEK, (draft) => {
        draft.settings = { ...(draft.settings ?? {}), baseURL: BASE_URL }
      })
    }),
})
