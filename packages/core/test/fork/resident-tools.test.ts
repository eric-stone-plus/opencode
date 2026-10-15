// The built-in tool surface is a contract (borrow C5). Every tool registered by the internal plugin set
// is context the model pays for in every session that can see it, and until now the set was an implicit
// consequence of a plugin list: adding a tool was not a decision anybody recorded.
//
// This test activates the internal plugin list the way the supervisor does - same nodes, same services,
// no mocks for the tool plugins themselves - and pins two things: the exact set the model is handed, and
// a byte budget over the rendered definitions plus the Code Mode catalog. A plugin that fails to
// activate fails this test too, because a tool that silently disappeared is the same problem in reverse.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Generate } from "@opencode/core/generate"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { Tool } from "@opencode/core/tool"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Npm } from "@opencode/util/npm"
import { emptyMcpLayer } from "../fixture/mcp"
import { tempGlobalLayer } from "../fixture/global"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"

/**
 * The built-in tools the provider is handed directly, plus the Code Mode `execute` tool that carries
 * every other registration. Changing this list is a deliberate act: update it here, in the same commit
 * that adds or removes a tool.
 */
const DIRECT = [
  "edit",
  "execute",
  "glob",
  "grep",
  "lsp",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
] as const

/** Tools reached through Code Mode instead of the native surface. */
const VIA_CODE_MODE = ["browser", "opencode"] as const

/**
 * Ceiling for the rendered surface: today's definitions plus catalog are ~79 KB, and the headroom is
 * for a tool to grow, not for a tool to appear - the list above is the exact pin for that.
 */
const SURFACE_BUDGET = 96_000

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)
const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))
const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

// The internal plugin list's own requirements, with the ambient nodes replaced so the suite stays
// offline and hermetic. `Plugin.node` is the registry the supervisor activates into.
const layer = AppNodeBuilder.build(LayerNode.group([Plugin.node, PluginInternal.requirements]), [
  Location.node.replace(tempLocationLayer),
  Global.node.replace(tempGlobalLayer),
  Npm.node.replace(npmLayer),
  Config.node.replace(Config.testLayer()),
  Mcp.node.replace(emptyMcpLayer),
  Generate.node.replace(generateLayer),
  Permission.node.replace(permissionLayer),
])

const it = testEffect(layer)

/** Activates the internal plugin list and returns the tool surface the model would be handed. */
const surface = Effect.fnUntraced(function* () {
  const internal = yield* PluginInternal.list()
  const plugins = yield* Plugin.Service
  const generation = (plugin: (typeof internal.pre)[number]) => ({
    ...plugin,
    revision: "internal",
    source: { type: "builtin" as const },
  })
  yield* plugins.activate([...internal.pre.map(generation), ...internal.post.map(generation)])
  const failed = (yield* plugins.list())
    .filter((item) => item.state?.status === "failed")
    .map((item) => item.id)
  const snapshot = yield* (yield* Tool.Service).snapshot()
  return {
    failed,
    direct: snapshot.definitions.map((tool) => tool.name).toSorted(),
    viaCodeMode: (snapshot.codeModeCatalog?.tools ?? []).map((tool) => tool.name).toSorted(),
    bytes: JSON.stringify(snapshot.definitions).length + JSON.stringify(snapshot.codeModeCatalog ?? {}).length,
  }
})

describe("the built-in tool surface", () => {
  it.effect("is exactly the set this fork decided to ship", () =>
    Effect.gen(function* () {
      const built = yield* surface()
      // A failed plugin is a tool that vanished, not a smaller surface.
      expect(built.failed).toEqual([])
      expect(built.direct).toEqual([...DIRECT].toSorted())
      expect(built.viaCodeMode).toEqual([...VIA_CODE_MODE].toSorted())
    }),
  )

  it.effect("stays inside its byte budget", () =>
    Effect.gen(function* () {
      const built = yield* surface()
      expect(built.bytes).toBeGreaterThan(0)
      expect(built.bytes).toBeLessThanOrEqual(SURFACE_BUDGET)
    }),
  )
})
