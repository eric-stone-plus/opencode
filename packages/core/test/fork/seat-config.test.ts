import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { PlanPlugin } from "@opencode/core/plugin/plan"
import { Document, Info } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

// The seat config is local-only on a running machine, but its tracked copies are part of the product:
// the repo-root mirror and the bootstrap bundle. These tests pin the two-profile policy there, and the
// effective semantics go through the same normalizer the runtime uses. The legacy `agent` block spells
// the removal `disable`; a `disabled` key is not a V1 field and normalize would push it into
// request.body instead of removing the agent (packages/core/src/v1/config/agent.ts).
const root = path.resolve(import.meta.dir, "../../../..")
const copies = ["opencode.jsonc", "bootstrap/config/opencode.jsonc"].map((file) => ({
  file,
  text: fs.readFileSync(path.join(root, file), "utf8"),
}))

const decode = Schema.decodeUnknownSync(Info)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))

const normalized = (text: string) => {
  const result = ConfigNormalize.normalize(Bun.JSONC.parse(text))
  if (result.type !== "normalized") throw new Error(`config did not normalize: ${JSON.stringify(result.diagnostics)}`)
  return { decoded: decode(result.encoded), encoded: result.encoded }
}

describe("fork seat config: two profiles", () => {
  for (const { file, text } of copies) {
    test(`${file} removes the build and plan agents`, () => {
      const { decoded, encoded } = normalized(text)
      expect(decoded.agents?.build?.disabled).toBe(true)
      expect(decoded.agents?.plan?.disabled).toBe(true)
      // The removal must not ride the provider request body (the legacy-key trap).
      expect(decoded.agents?.build?.request?.body ?? {}).not.toHaveProperty("disabled")
      expect(JSON.stringify(encoded)).not.toContain('"request":{"body":{"disable')
      expect(decoded.agents?.auto?.mode).toBe("primary")
      expect(decoded.agents?.goal?.mode).toBe("primary")
    })

    test(`${file} keeps auto blue, goal red and auto as the default`, () => {
      const { decoded } = normalized(text)
      expect(decoded.agents?.auto?.color).toBe("#5c9cf5")
      expect(decoded.agents?.goal?.color).toBe("#e06c75")
      expect(decoded.default_agent).toBe("auto")
    })
  }

  test("the tracked copies agree on the agent section", () => {
    const section = (text: string) => text.slice(text.search(/^ {2}"agent": \{$/m))
    expect(section(copies[0]!.text)).toBe(section(copies[1]!.text))
  })

  test("the goal agent markdown keeps its red and drops the plan permissions", () => {
    const text = fs.readFileSync(path.join(root, "dotfiles/opencode/agent/goal.md"), "utf8")
    const frontmatter = text.slice(0, text.indexOf("\n---", 4))
    expect(frontmatter).toContain('color: "#e06c75"')
    expect(frontmatter).not.toContain("plan_enter")
    expect(frontmatter).not.toContain("plan_exit")
  })

  test("the goal agent mirrors agree", () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")
    expect(read("bootstrap/agent/goal.md")).toBe(read("dotfiles/opencode/agent/goal.md"))
  })

  test("the legacy removal key is `disable`; `disabled` would ride the request body", () => {
    const removal = normalized(`{"agent":{"build":{"disable":true}}}`)
    expect(removal.decoded.agents?.build?.disabled).toBe(true)
    const trap = normalized(`{"agent":{"build":{"disabled":true}}}`)
    expect(trap.decoded.agents?.build?.disabled).toBeUndefined()
    expect((trap.decoded.agents?.build?.request?.body as Record<string, unknown> | undefined)?.disabled).toBe(true)
  })

  test("no tracked config carries the retired instructions array", () => {
    for (const { text } of copies) {
      expect(text).not.toMatch(/^\s*"instructions"\s*:/m)
      expect(text).not.toContain("autonomy.md")
      expect(text).not.toContain("AGENTS.goal.md")
    }
  })

  test("the mode cards are mirrored, managed, and keep the two contracts apart", () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")
    for (const card of ["agent/auto.md", "agent/goal.md"]) {
      const body = read(path.join("bootstrap", card))
      expect(body).toBe(read(path.join("dotfiles/opencode", card)))
      expect(body).toContain("# Harness")
      expect(body).toMatch(/^mode: primary$/m)
      expect(body).toContain("this file is managed")
    }
    expect(read("bootstrap/agent/auto.md")).toContain("no Round-1/Round-2 swarm")
    expect(read("bootstrap/agent/auto.md")).not.toContain("## Round 2")
    expect(read("bootstrap/agent/goal.md")).toContain("Round 2")
  })

  test("the retired instruction documents stay deleted", () => {
    for (const file of [
      "bootstrap/autonomy.md",
      "bootstrap/AGENTS.goal.md",
      "dotfiles/opencode/autonomy.md",
      "dotfiles/opencode/AGENTS.goal.md",
    ]) {
      expect(fs.existsSync(path.join(root, file))).toBe(false)
    }
  })

  // The unit assertions above only prove what the config *says*. This one boots the real chain in the
  // registration order of PluginInternal.list() — AgentPlugin and PlanPlugin create the primaries in
  // `pre`, ConfigAgentPlugin removes the disabled ones in `post` — and pins the selectable list, so a
  // new upstream primary or a removal that stops working fails here instead of shipping a third mode.
  it.effect("the tracked seat config leaves exactly auto and goal selectable", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const { decoded } = normalized(copies[0]!.text)

      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
      yield* PlanPlugin.Plugin.effect(
        host({
          agent: agentHost(agents),
          // oxlint-disable-next-line no-explicit-any
          tool: { hook: () => Effect.succeed({ dispose: Effect.void }) } as never,
          // oxlint-disable-next-line no-explicit-any
          session: { hook: () => Effect.succeed({ dispose: Effect.void }) } as never,
        }),
      )
      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer([new Document({ type: "document", info: decoded })])),
      )

      expect(yield* agents.get(Agent.ID.make("build"))).toBeUndefined()
      expect(yield* agents.get(Agent.ID.make("plan"))).toBeUndefined()
      const selectable = (yield* agents.list())
        .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
        .map((agent) => String(agent.id))
      expect(selectable.toSorted()).toEqual(["auto", "goal"])
    }),
  )
})
