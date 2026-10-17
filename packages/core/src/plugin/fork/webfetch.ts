export * as ForkWebFetchPlugin from "./webfetch.js"

import type { Tool } from "@opencode/schema/tool"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { HttpClient } from "effect/http"
import { App } from "../../app.js"
import { credential, fetchWithKey } from "../../deepseek.js"
import { WebFetchTool } from "../../tool/plugin/webfetch.js"

/**
 * Prefers DeepSeek's native Fetch API for Markdown requests.
 *
 * The Fetch API returns the page already converted to Markdown, so it avoids the
 * local HTML parser and works for JS-heavy pages. It is an optimization, not a
 * hard dependency: a missing key, a non-Markdown format, an unsupported URL, a
 * timeout, or any API failure falls back to the original direct HTTP tool. The
 * original tool keeps its permission check, Cloudflare retry and byte budget.
 */
export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "fork.webfetch.deepseek",
  effect: (ctx) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      yield* ctx.tool.transform((editor) => {
        const original = editor.get(WebFetchTool.name)
        if (!original) return
        editor.add({
          ...original,
          description: `${original.description}\n\nMarkdown fetches use DeepSeek's Fetch API when available, with a direct HTTP fallback.`,
          execute: (input: typeof WebFetchTool.Input.Type, context: Tool.Context) =>
            Effect.gen(function* () {
              if (input.format !== "markdown") return yield* original.execute(input, context)
              const target = URL.parse(input.url)
              if (
                !target ||
                (target.protocol !== "http:" && target.protocol !== "https:") ||
                target.username.length > 0 ||
                target.password.length > 0 ||
                input.url.length > 8_192
              )
                return yield* original.execute(input, context)

              const resolved = yield* credential(ctx).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              if (!resolved) return yield* original.execute(input, context)

              yield* ctx.permission.assert({
                action: WebFetchTool.name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })

              const page = yield* fetchWithKey(
                http,
                resolved.key,
                input.url,
                input.timeout ?? WebFetchTool.DEFAULT_TIMEOUT_SECONDS,
                { userAgent: App.useragent(ctx.app) },
              ).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              if (!page) return yield* original.execute(input, context)

              return {
                output: {
                  url: input.url,
                  contentType: "text/markdown",
                  format: "markdown" as const,
                  output: page.content,
                },
                content: page.content,
                metadata: { contentType: "text/markdown", source: "deepseek" },
              }
            }),
        })
      })
    }),
})
