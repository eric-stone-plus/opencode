import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { Skill } from "../../src/skill"
import { Command } from "../../src/command"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Command.node, Skill.node, CrossSpawnSpawner.node, Ripgrep.node])),
)

const isolateHome = (dir: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      return prev
    }),
    () => Effect.void,
    (prev) =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = prev
      }),
  )

const USER_ONLY_SKILL = `---
name: user-only
description: A skill only the user can invoke.
disable-model-invocation: true
---

# User Only

Slash command only.
`

describe("skill invocation", () => {
  it.instance("execute refuses model invocation of user-only skills", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => Bun.write(path.join(dir, ".opencode", "skill", "user-only", "SKILL.md"), USER_ONLY_SKILL))
      yield* isolateHome(dir)

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const exit = yield* tool.execute({ name: "user-only" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Skill.ModelInvocationDisabledError)
        if (error instanceof Error) {
          expect(error.message).toContain("user-invocable only")
          expect(error.message).toContain("/user-only")
        }
      }
      expect(requests.length).toBe(0)
    }),
  )

  it.instance("execute serves the on-disk skill body at execute time", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, ".opencode", "skill", "fresh-skill", "SKILL.md")
      const writeBody = (body: string) =>
        Effect.promise(() =>
          Bun.write(
            file,
            `---
name: fresh-skill
description: Freshness test skill.
---

# Fresh Skill

${body}
`,
          ),
        )
      yield* writeBody("BODY-V1")
      yield* isolateHome(dir)

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const ctx: Tool.Context = { ...baseCtx, ask: () => Effect.void }

      const before = yield* tool.execute({ name: "fresh-skill" }, ctx)
      expect(before.output).toContain("BODY-V1")

      yield* writeBody("BODY-V2")

      const after = yield* tool.execute({ name: "fresh-skill" }, ctx)
      expect(after.output).toContain("BODY-V2")
      expect(after.output).not.toContain("BODY-V1")

      const skill = yield* Skill.Service
      expect((yield* skill.require("fresh-skill")).content).toContain("BODY-V2")
    }),
  )

  it.instance("execute falls back to the cached body when the skill file vanished", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, ".opencode", "skill", "gone-skill", "SKILL.md")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `---
name: gone-skill
description: Vanishing test skill.
---

# Gone Skill

CACHED-BODY
`,
        ),
      )
      yield* isolateHome(dir)

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const ctx: Tool.Context = { ...baseCtx, ask: () => Effect.void }
      const before = yield* tool.execute({ name: "gone-skill" }, ctx)
      expect(before.output).toContain("CACHED-BODY")

      yield* Effect.promise(() => fs.rm(file))

      const after = yield* tool.execute({ name: "gone-skill" }, ctx)
      expect(after.output).toContain("CACHED-BODY")
    }),
  )

  it.instance("execute stamps the vendored skill revision from PROVENANCE.md", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "rev-skill", "SKILL.md"),
          `---
name: rev-skill
description: Revision stamp test skill.
---

# Rev Skill

REV-BODY
`,
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "PROVENANCE.md"),
          `# Vendored skills

Generated by a script. Do not hand-edit.

- Source: example/skills (upstream)
- Revision: \`deadbeefcafebabe0123456789abcdef01234567\` (main)
- Vendored: 2026-10-07
`,
        ),
      )
      yield* isolateHome(dir)

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const result = yield* tool.execute({ name: "rev-skill" }, { ...baseCtx, ask: () => Effect.void })
      expect(result.metadata.skill_revision).toBe("deadbeefcafebabe0123456789abcdef01234567")
      expect(result.output).toContain("Skill revision: deadbeefcafebabe0123456789abcdef01234567")
    }),
  )

  it.instance("execute omits the revision stamp when PROVENANCE.md is missing", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "norev-skill", "SKILL.md"),
          `---
name: norev-skill
description: No revision stamp test skill.
---

# NoRev Skill

NOREV-BODY
`,
        ),
      )
      yield* isolateHome(dir)

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const result = yield* tool.execute({ name: "norev-skill" }, { ...baseCtx, ask: () => Effect.void })
      expect(result.metadata.skill_revision).toBeUndefined()
      expect(result.output).not.toContain("Skill revision:")
    }),
  )

  it.instance("command registration still sees user-only skills", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => Bun.write(path.join(dir, ".opencode", "skill", "user-only", "SKILL.md"), USER_ONLY_SKILL))
      yield* isolateHome(dir)

      const command = yield* Command.Service
      const item = yield* command.get("user-only")
      expect(item).toBeDefined()
      expect(item!.source).toBe("skill")
      expect(item!.description).toBe("A skill only the user can invoke.")
    }),
  )
})
