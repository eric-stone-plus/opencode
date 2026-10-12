import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { ForkInstructionsPlugin } from "@opencode/core/plugin/fork/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../../fixture/location"
import { tmpdir } from "../../fixture/tmpdir"
import { testEffect } from "../../lib/effect"
import { host } from "../host"

const document = (...instructions: string[]) => new Document({ type: "document", info: new Info({ instructions }) })

const it = testEffect(Layer.empty)

/** Runs the loader against real files: home holds the config-dir files, project is the location. */
const run = (instructions: string[], seed: (home: string, project: string) => Promise<void>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const home = path.join(tmp.path, "home")
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(async () => {
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(project, { recursive: true })
      await seed(home, project)
    })
    const layer = Layer.mergeAll(
      AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node, FSUtil.node]), []),
      Config.testLayer([document(...instructions.map((entry) => entry.replace("$HOME", home)))]),
      Layer.succeed(Global.Service, Global.Service.of(Global.make({ home }))),
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
    )
    return yield* Effect.gen(function* () {
      yield* ForkInstructionsPlugin.Plugin.effect(host())
      return (yield* (yield* InstructionDiscovery.Service).list()) as InstructionDiscovery.File[]
    }).pipe(Effect.provide(layer))
  })

describe("fork instructions loader", () => {
  it.effect("loads absolute and home-relative files as instruction files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* run(["~/autonomy.md", "$HOME/AGENTS.goal.md"], async (home) => {
          await fs.writeFile(path.join(home, "autonomy.md"), "be autonomous")
          await fs.writeFile(path.join(home, "AGENTS.goal.md"), "goal playbook")
        })
        expect(files.map((file) => [path.basename(file.path), file.content])).toEqual([
          ["autonomy.md", "be autonomous"],
          ["AGENTS.goal.md", "goal playbook"],
        ])
      }),
    ),
  )

  it.effect("expands globs, searches relative entries upward, skips URLs and missing files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* run(
          ["$HOME/rules-*.md", "STYLE.md", "https://example.test/rules.md", "$HOME/missing.md"],
          async (home, project) => {
            await fs.writeFile(path.join(home, "rules-a.md"), "a")
            await fs.writeFile(path.join(home, "rules-b.md"), "b")
            await fs.writeFile(path.join(project, "STYLE.md"), "style")
          },
        )
        expect(files.map((file) => path.basename(file.path)).toSorted()).toEqual(["STYLE.md", "rules-a.md", "rules-b.md"])
      }),
    ),
  )

  it.effect("renders each file as an Instructions-from block", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* run(["$HOME/one.md"], async (home) => {
          await fs.writeFile(path.join(home, "one.md"), "first")
        })
        expect(files).toHaveLength(1)
        expect(files[0]?.content).toBe("first")
      }),
    ),
  )
})
