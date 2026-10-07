import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { Command } from "../../src/command"
import { Skill } from "../../src/skill"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Command.node, Skill.node, CrossSpawnSpawner.node, Ripgrep.node])),
)

describe("command config overrides", () => {
  it.instance(
    "pins a review model without replacing the built-in template",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const review = yield* command.get("review")
        if (!review) throw new Error("review command not found")
        expect(review.model).toBe("test/pinned-model")
        expect(review.subtask).toBe(true)
        const template = yield* Effect.promise(() => Promise.resolve(review.template))
        expect(template).toContain("Coverage Ledger")
        expect(review.description).toBe("review changes [commit|branch|pr], defaults to uncommitted")
      }),
    { config: { command: { review: { model: "test/pinned-model" } } } },
  )

  it.instance(
    "keeps subagent mode when the review template is overridden",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const review = yield* command.get("review")
        if (!review) throw new Error("review command not found")
        const template = yield* Effect.promise(() => Promise.resolve(review.template))
        expect(template).toBe("custom review $ARGUMENTS")
        expect(review.model).toBe("test/pinned-model")
        expect(review.subtask).toBe(true)
        expect(review.hints).toContain("$ARGUMENTS")
      }),
    { config: { command: { review: { template: "custom review $ARGUMENTS", model: "test/pinned-model" } } } },
  )

  it.instance(
    "respects an explicit subtask false on review",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const review = yield* command.get("review")
        if (!review) throw new Error("review command not found")
        expect(review.subtask).toBe(false)
      }),
    { config: { command: { review: { template: "inline review $ARGUMENTS", subtask: false } } } },
  )
})
