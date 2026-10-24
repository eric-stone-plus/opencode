import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { ForkModesPlugin } from "@opencode/core/plugin/fork/modes"
import { ForkProfilesPlugin } from "@opencode/core/plugin/fork/profiles"
import { PlanPlugin } from "@opencode/core/plugin/plan"
import { Session } from "@opencode/core/session"
import { Document, Info } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const decode = Schema.decodeUnknownSync(Info)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))

function document(text: string) {
  const result = ConfigNormalize.normalize(Bun.JSONC.parse(text))
  if (result.type !== "normalized") throw new Error(`config did not normalize: ${JSON.stringify(result.diagnostics)}`)
  return new Document({ type: "document", info: decode(result.encoded) })
}

/** The production order: built-in creators, the fork's profile defaults, then the config plugin. */
const boot = (entries: Document[] = []) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const layer = Config.testLayer(entries)
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
    yield* ForkProfilesPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(Effect.provide(layer))
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(Effect.provide(layer))
    return agents
  })

/** The production order plus the post modes pass: profiles, config agents, then default/floor. */
const bootWithModes = (text: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const layer = Config.testLayer([document(text)])
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
    yield* ForkProfilesPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(Effect.provide(layer))
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(Effect.provide(layer))
    yield* ForkModesPlugin.Plugin.effect(
      host({ agent: agentHost(agents), session: { hook: () => Effect.succeed({ dispose: Effect.void }) } }),
    ).pipe(
      Effect.provide(Layer.merge(layer, Layer.succeed(Session.Service, Session.Service.of({} as never)))),
    )
    return agents
  })

const selectable = (agents: readonly Agent.Info[]) =>
  agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => String(agent.id))

/** The built-in prompt must be the managed card body, not a stale or frontmatter-leaking copy. */
const cardBody = (relative: string) => {
  const card = readFileSync(new URL(relative, import.meta.url), "utf8")
  const end = card.indexOf("\n---", 4)
  return (end === -1 ? card : card.slice(end + 4)).trim()
}

describe("fork profiles without a seat config", () => {
  it.effect("a fresh clone exposes exactly auto and goal, defaulting to auto", () =>
    Effect.gen(function* () {
      const agents = yield* boot()
      expect(selectable(yield* agents.list())).toEqual(["auto", "goal"])
      expect(String((yield* agents.resolve())?.id)).toBe("auto")
      expect(yield* agents.get(Agent.ID.make("build"))).toBeUndefined()
      expect(yield* agents.get(Agent.ID.make("plan"))).toBeUndefined()
      expect((yield* agents.get(Agent.ID.make("auto")))?.color).toBe("#5c9cf5")
      expect((yield* agents.get(Agent.ID.make("goal")))?.color).toBe("#e06c75")
      const auto = yield* agents.get(Agent.ID.make("auto"))
      const goal = yield* agents.get(Agent.ID.make("goal"))
      expect(auto?.system).toBe(cardBody("../../../../bootstrap/agent/auto.md"))
      expect(goal?.system).toBe(cardBody("../../../../bootstrap/agent/goal.md"))
      expect(auto?.system).not.toContain("description:")
      expect(goal?.system).not.toContain("description:")
    }),
  )

  it.effect("both profiles refuse the question tool and the seat", () =>
    Effect.gen(function* () {
      const agents = yield* boot()
      for (const id of ["auto", "goal"] as const) {
        const agent = yield* agents.get(Agent.ID.make(id))
        const rules = agent?.permissions ?? []
        // Both resource forms the edit tool can produce: location-relative and absolute (external).
        for (const resource of [
          ".config/opencode/opencode.jsonc",
          "/home/someone/.config/opencode/agent/goal.md",
          "~/.config/opencode/opencode.jsonc",
        ])
          expect(Permission.evaluate("edit", resource, rules).effect).toBe("deny")
        expect(rules.some((rule) => rule.action === "question" && rule.effect === "deny")).toBe(true)
      }
    }),
  )
})

describe("fork profiles respect an explicit seat config", () => {
  it.effect("a declared upstream primary stays and an explicit default wins", () =>
    Effect.gen(function* () {
      const agents = yield* boot([
        document(
          `{"default_agent":"goal","agent":{"build":{"mode":"primary"},"goal":{"mode":"primary","color":"#123456"}}}`,
        ),
      ])
      expect(yield* agents.get(Agent.ID.make("build"))).toBeDefined()
      expect(yield* agents.get(Agent.ID.make("plan"))).toBeUndefined()
      expect((yield* agents.get(Agent.ID.make("goal")))?.color).toBe("#123456")
      expect(String((yield* agents.resolve())?.id)).toBe("goal")
      expect(selectable(yield* agents.list())).toContain("build")
    }),
  )

  it.effect("a disabled profile is not re-created and the other profile becomes the default", () =>
    Effect.gen(function* () {
      const agents = yield* boot([document(`{"agent":{"auto":{"disable":true}}}`)])
      expect(yield* agents.get(Agent.ID.make("auto"))).toBeUndefined()
      expect(selectable(yield* agents.list())).toEqual(["goal"])
      expect(String((yield* agents.resolve())?.id)).toBe("goal")
    }),
  )

  it.effect("a config-declared auto without default_agent still selects auto after the post pass", () =>
    Effect.gen(function* () {
      const agents = yield* bootWithModes(`{"permission":"allow","agent":{"auto":{"color":"#112233"}}}`)
      const auto = yield* agents.get(Agent.ID.make("auto"))
      expect(String((yield* agents.resolve())?.id)).toBe("auto")
      expect(auto?.system).toBe(cardBody("../../../../bootstrap/agent/auto.md"))
      expect(Permission.evaluate("question", "*", auto?.permissions ?? []).effect).toBe("deny")
      expect(
        Permission.evaluate("edit", "/home/someone/.config/opencode/opencode.jsonc", auto?.permissions ?? []).effect,
      ).toBe("deny")
    }),
  )

  it.effect("an empty declared permission block does not let a global allow re-open question", () =>
    Effect.gen(function* () {
      const agents = yield* bootWithModes(`{"permission":"allow","agent":{"auto":{"permissions":[]}}}`)
      const auto = yield* agents.get(Agent.ID.make("auto"))
      expect(Permission.evaluate("question", "*", auto?.permissions ?? []).effect).toBe("deny")
      expect(
        Permission.evaluate("edit", "/home/someone/.config/opencode/opencode.jsonc", auto?.permissions ?? []).effect,
      ).toBe("deny")
    }),
  )

  it.effect("a partial declared permission block does not drop the question/seat floors", () =>
    Effect.gen(function* () {
      const agents = yield* bootWithModes(
        `{"permission":"allow","agent":{"auto":{"permissions":[{"action":"todowrite","resource":"*","effect":"deny"}]}}}`,
      )
      const auto = yield* agents.get(Agent.ID.make("auto"))
      expect(Permission.evaluate("question", "*", auto?.permissions ?? []).effect).toBe("deny")
      expect(
        Permission.evaluate("edit", "/home/someone/.config/opencode/opencode.jsonc", auto?.permissions ?? []).effect,
      ).toBe("deny")
    }),
  )
})

// Keep the test honest about the config spelling: `disable` is the legacy key the config plugin
// understands, and `disabled` is not a V1 field (it would ride the request body instead).
test("the legacy removal key is the one the profile plugin observes", () => {
  const disabled = document(`{"agent":{"auto":{"disable":true}}}`)
  expect(disabled.info.agents?.auto?.disabled).toBe(true)
})
