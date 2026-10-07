import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          if (info.disableModelInvocation) return yield* new Skill.ModelInvocationDisabledError({ name: info.name })

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          // The built-in skill has no directory on disk. `path.dirname` of its
          // sentinel resolves to ".", which would list the user's cwd as if
          // those files were skill resources.
          const dir = info.location === "<built-in>" ? undefined : path.dirname(info.location)
          const files = dir
            ? yield* ripgrep.find({
                cwd: dir,
                pattern: "!**/SKILL.md",
                hidden: true,
                follow: false,
                signal: ctx.abort,
                limit: 10,
              })
            : []

          // The body must be re-read at execute time, not served from the
          // InstanceState snapshot taken at system-prompt build: plugins
          // (mpskills-update) refresh vendored SKILL.md files in
          // `tool.execute.before`, after that snapshot. The description stays
          // cached — the catalog already shipped in the system prompt. Falls
          // back to the cached body if the file vanished or no longer parses.
          // A successful re-read also refreshes the state copy so /commands
          // (which read `item.content` at template access) serve fresh text.
          const fresh =
            info.location === "<built-in>"
              ? undefined
              : yield* Effect.tryPromise({
                  try: () => ConfigMarkdown.parse(info.location),
                  catch: (error) => error,
                }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (fresh) info.content = fresh.content

          // Stamp the vendored revision so quotes in reports are reproducible:
          // vendored trees carry a PROVENANCE.md next to the skill folders.
          const revision = dir
            ? yield* Effect.tryPromise({
                try: () => Bun.file(path.join(path.dirname(dir), "PROVENANCE.md")).text(),
                catch: (error) => error,
              }).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
                Effect.map((text) => text?.match(/^- Revision: `([0-9a-f]+)`/m)?.[1]),
              )
            : undefined

          // Placed after the loaded body rather than only in the system prompt:
          // several skills instruct the agent to wait for a human, and a distant
          // instruction loses to the one the model just read. Head-truncation of
          // an oversized skill can drop it; the system prompt copy survives.
          const autonomy = typeof ctx.extra?.autonomy === "string" ? ctx.extra.autonomy : undefined

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              ...(revision ? ["", `Skill revision: ${revision}`] : []),
              ...(dir
                ? [
                    "",
                    `Base directory for this skill: ${dir}`,
                    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
                    "Note: file list is sampled.",
                    "",
                    "<skill_files>",
                    files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
                    "</skill_files>",
                  ]
                : []),
              "</skill_content>",
              ...(autonomy ? ["", autonomy] : []),
            ].join("\n"),
            metadata: {
              name: info.name,
              ...(dir ? { dir } : {}),
              ...(revision ? { skill_revision: revision } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
