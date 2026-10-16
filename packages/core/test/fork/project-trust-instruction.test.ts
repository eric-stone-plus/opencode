import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { readInitial } from "../lib/instructions"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  home: string
  config: string
  directory: string
  projectDirectory: string
  trust?: ProjectTrust.Data
  project?: boolean
}) => {
  const watcher = Watcher.testLayer
  const config = Config.testLayer([])
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        InstructionDiscovery.node,
        Bus.node,
        Config.node,
        FSUtil.node,
        Global.node,
        Location.node,
        Watcher.node,
      ]),
      [
        Config.node.replace(config),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project })),
        Global.node.replace(Global.layerWith({ home: input.home, config: input.config })),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(input.directory) },
                { projectDirectory: AbsolutePath.make(input.projectDirectory) },
              ),
            ),
          ),
        ),
        Watcher.node.replace(watcher),
        ...(input.trust ? [ProjectTrust.node.replace(ProjectTrust.layer(input.trust))] : []),
      ],
    ),
    watcher,
    config,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
      ),
    ),
  )
}

const start = Effect.fnUntraced(function* (ctx = host()) {
  yield* ConfigInstructionPlugin.Plugin.effect(ctx)
  return yield* InstructionDiscovery.Service
})

type Layout = {
  readonly home: string
  readonly global: string
  readonly root: string
  readonly start: string
  readonly outside: string
  readonly shared: string
  readonly globalFile: string
  readonly projectFile: string
  readonly packagesFile: string
  readonly startFile: string
}

const layout = (tmp: string): Layout => {
  const home = path.join(tmp, "home")
  const global = path.join(tmp, "global")
  const root = path.join(home, "code", "repo")
  const start = path.join(root, "packages", "core")
  return {
    home,
    global,
    root,
    start,
    outside: path.join(tmp, "AGENTS.md"),
    shared: path.join(home, "code", "AGENTS.md"),
    globalFile: path.join(global, "AGENTS.md"),
    projectFile: path.join(root, "AGENTS.md"),
    packagesFile: path.join(root, "packages", "AGENTS.md"),
    startFile: path.join(start, "AGENTS.md"),
  }
}

const prepare = (input: Layout) =>
  Effect.promise(async () => {
    await fs.mkdir(input.start, { recursive: true })
    await fs.mkdir(input.global, { recursive: true })
    await Promise.all([
      fs.writeFile(input.outside, "outside"),
      fs.writeFile(input.shared, "shared"),
      fs.writeFile(input.globalFile, "global"),
      fs.writeFile(input.projectFile, "project"),
      fs.writeFile(input.packagesFile, "packages"),
      fs.writeFile(input.startFile, "package"),
    ])
  })

const scenario = <E, R>(
  body: (files: Layout) => Effect.Effect<void, E, R>,
  options: (files: Layout) => { trust?: ProjectTrust.Data; project?: boolean } = () => ({}),
) =>
  tmpdirScoped().pipe(
    Effect.flatMap((tmp) => {
      const files = layout(tmp.path)
      const extra = options(files)
      return body(files).pipe(
        Effect.provide(
          instructionLayer({
            home: files.home,
            config: files.global,
            directory: files.start,
            projectDirectory: files.root,
            trust: extra.trust,
            project: extra.project,
          }),
        ),
      )
    }),
  )

describe("ConfigInstructionPlugin.Plugin with project trust", () => {
  it.live("a declared root admits project files from the root down and nothing above it", () =>
    scenario(
      (files) =>
        Effect.gen(function* () {
          yield* prepare(files)
          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual([
            { path: files.globalFile, type: "file" },
            { path: files.startFile, type: "file" },
            { path: files.packagesFile, type: "file" },
            { path: files.projectFile, type: "file" },
          ])
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(
            [
              `Instructions from: ${files.globalFile}\nglobal`,
              `Instructions from: ${files.startFile}\npackage`,
              `Instructions from: ${files.packagesFile}\npackages`,
              `Instructions from: ${files.projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.text).not.toContain("shared")
          expect(initialized.text).not.toContain("outside")
        }),
      (files) => ({ trust: { all: false, roots: [files.root] } }),
    ),
  )

  it.live("with no declaration only global sources are admitted", () =>
    scenario((files) =>
      Effect.gen(function* () {
        yield* prepare(files)
        const discovery = yield* start()
        expect(discovery.trust.data).toEqual({ all: false, roots: [] })
        expect(discovery.trust.allows(files.start)).toBe(false)
        expect(discovery.trust.nearestRoot(files.start)).toBeUndefined()
        const watcher = yield* Watcher.Test
        expect(yield* watcher.subscriptions()).toEqual([{ path: files.globalFile, type: "file" }])
        const initialized = yield* readInitial(yield* discovery.load())
        expect(initialized.text).toBe(`Instructions from: ${files.globalFile}\nglobal`)
      }),
    ),
  )

  it.live("the coarse project escape forces everything closed even when a root is declared", () =>
    scenario(
      (files) =>
        Effect.gen(function* () {
          yield* prepare(files)
          const discovery = yield* start()
          expect(discovery.project).toBe(false)
          expect(discovery.trust.data).toEqual({ all: false, roots: [] })
          expect(discovery.trust.allows(files.start)).toBe(false)
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual([{ path: files.globalFile, type: "file" }])
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(`Instructions from: ${files.globalFile}\nglobal`)
        }),
      (files) => ({ trust: { all: false, roots: [files.root] }, project: false }),
    ),
  )

  it.live("all: true keeps the walk to home, above any root", () =>
    scenario(
      (files) =>
        Effect.gen(function* () {
          yield* prepare(files)
          const discovery = yield* start()
          expect(discovery.trust.data.all).toBe(true)
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toContain(`Instructions from: ${files.shared}\nshared`)
          expect(initialized.text).toContain(`Instructions from: ${files.projectFile}\nproject`)
          expect(initialized.text).not.toContain("outside")
        }),
      () => ({ trust: { all: true, roots: [] } }),
    ),
  )
})
