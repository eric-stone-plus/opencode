import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

type Input = {
  directory: string
  projectDirectory: string
  home: string
  config: string
  trust?: ProjectTrust.Data
  project?: boolean
  filesystem?: Layer.Layer<FSUtil.Service>
}

const discover = (input: Input) =>
  ConfigDiscovery.discover(input.project === undefined ? undefined : { project: input.project }).pipe(
    Effect.provide(
      Layer.mergeAll(
        input.filesystem ?? LayerNode.compile(FSUtil.node),
        Layer.succeed(Global.Service, Global.make({ home: input.home, config: input.config })),
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location(
              { directory: AbsolutePath.make(input.directory) },
              { projectDirectory: AbsolutePath.make(input.projectDirectory) },
            ),
          ),
        ),
        input.trust ? ProjectTrust.layer(input.trust) : Layer.empty,
      ),
    ),
  )

const make = (directory: string) => fs.mkdir(directory, { recursive: true })

describe("ConfigDiscovery.discover with project trust", () => {
  it.live("a declared root yields its project files and never the directories above it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const config = path.join(home, ".config", "opencode")
      const root = path.join(tmp.path, "repo")
      const start = path.join(root, "packages", "core")
      yield* Effect.promise(() =>
        Promise.all([
          make(start),
          make(path.join(root, ".opencode")),
          make(path.join(root, "packages", ".opencode")),
          make(path.join(tmp.path, ".opencode")),
          make(home),
          make(config),
        ]),
      )

      const sources = yield* discover({
        directory: start,
        projectDirectory: root,
        home,
        config,
        trust: { all: false, roots: [root] },
      })

      const direct = sources.direct.map((item) => item as string)
      expect(direct).toContain(path.join(root, "opencode.json"))
      expect(direct).toContain(path.join(root, "packages", "opencode.json"))
      expect(direct).toContain(path.join(start, "opencode.json"))
      expect(direct).not.toContain(path.join(tmp.path, "opencode.json"))
      const project = sources.project.map((item) => item.path as string)
      expect(project).toContain(path.join(root, ".opencode"))
      expect(project).toContain(path.join(root, "packages", ".opencode"))
      expect(project).not.toContain(path.join(tmp.path, ".opencode"))
    }),
  )

  it.live("the walk is bounded by the nearest declared root, so nothing above it is consulted", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const config = path.join(home, ".config", "opencode")
      const root = path.join(tmp.path, "repo")
      const nested = path.join(root, "packages")
      const start = path.join(nested, "core")
      yield* Effect.promise(() => Promise.all([make(start), make(home), make(config)]))
      const observed: FSUtil.UpOptions[] = []
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) => Effect.sync(() => (observed.push(options), [] as string[])),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* discover({
        directory: start,
        projectDirectory: root,
        home,
        config,
        trust: { all: false, roots: [root, nested] },
        filesystem: observingFS,
      })

      expect(observed).toHaveLength(1)
      expect(observed[0].start).toBe(start)
      // The nested declaration is the nearest root; the walk stops there, not at the outer root.
      expect(observed[0].stop).toBe(nested)
    }),
  )

  it.live("with no declaration nothing project-side is discovered", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const config = path.join(home, ".config", "opencode")
      const root = path.join(tmp.path, "repo")
      const start = path.join(root, "packages", "core")
      yield* Effect.promise(() =>
        Promise.all([make(start), make(path.join(root, ".opencode")), make(home), make(config)]),
      )

      const sources = yield* discover({ directory: start, projectDirectory: root, home, config })
      expect(sources.project).toEqual([])
      expect(sources.direct).toEqual([])
    }),
  )

  it.live("the coarse project escape forces everything closed even when a root is declared", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const config = path.join(home, ".config", "opencode")
      const root = path.join(tmp.path, "repo")
      const start = path.join(root, "packages", "core")
      yield* Effect.promise(() =>
        Promise.all([make(start), make(path.join(root, ".opencode")), make(home), make(config)]),
      )

      const sources = yield* discover({
        directory: start,
        projectDirectory: root,
        home,
        config,
        trust: { all: false, roots: [root] },
        project: false,
      })
      expect(sources.project).toEqual([])
      expect(sources.direct).toEqual([])
    }),
  )

  it.live("all: true keeps the unbounded walk", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const config = path.join(home, ".config", "opencode")
      const root = path.join(tmp.path, "repo")
      const start = path.join(root, "packages", "core")
      yield* Effect.promise(() =>
        Promise.all([make(start), make(path.join(tmp.path, ".opencode")), make(home), make(config)]),
      )

      const sources = yield* discover({
        directory: start,
        projectDirectory: root,
        home,
        config,
        trust: { all: true, roots: [] },
      })
      expect(sources.project.map((item) => item.path as string)).toContain(path.join(tmp.path, ".opencode"))
    }),
  )
})
