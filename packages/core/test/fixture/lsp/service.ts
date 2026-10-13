import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { LSP } from "@opencode/core/fork/lsp/lsp"
import type { LSPServer } from "@opencode/core/fork/lsp/server"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"
import { HttpClient } from "effect/http"
import path from "path"
import { hostEnvironmentLayer } from "../environment"
import { location } from "../location"
import { tmpdirScoped } from "../tmpdir"

/** A config document that sets only `lsp`, in the shape a user writes it. */
export const lspDocument = (lsp: unknown): Entry => new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ lsp }) })

export interface Harness {
  /** The project directory the Location points at. */
  readonly directory: string
  /** The `type` of every event the runtime published, in order. */
  readonly events: string[]
  /** Every package the runtime asked npm for, as `package` or `package:bin`. */
  readonly npm: string[]
  /** Every URL the runtime requested over HTTP. */
  readonly http: string[]
  /** Every command a server resolver or installer asked the process service to run. */
  readonly processes: string[]
  /** Where downloaded tools would be installed. */
  readonly bin: string
}

export interface Options {
  readonly entries?: Entry[]
  readonly flags?: Partial<LSPServer.Flags>
  /** The environment servers and tools are looked up in. An empty directory keeps the test independent of the machine's PATH. */
  readonly env?: NodeJS.ProcessEnv
  readonly builtIns?: readonly LSPServer.Info[]
  /** Where the project's worktree is; defaults to the project directory. */
  readonly worktree?: (directory: string) => string
  /** LSP instance reaping knobs, for the tests that exercise them. */
  readonly idleTimeToLive?: Duration.Input
  readonly sweepInterval?: Duration.Input
  readonly maxClients?: number
}

/**
 * The runtime's dependencies, faked where they would reach outside the test: npm, the network, and the
 * event bus record what they were asked for, and the filesystem and process spawner are the real ones.
 * The layer also provides `Config.Test` so a test can change the configuration like a reload would.
 */
export const lspLayer = (options: Options = {}) => {
  const harness = { directory: "", events: [], npm: [], http: [], processes: [], bin: "" } as {
    -readonly [K in keyof Harness]: Harness[K]
  }
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const empty = yield* tmpdirScoped()
      harness.directory = tmp.path
      harness.bin = path.join(empty.path, "bin")
      const directory = AbsolutePath.make(tmp.path)
      const env = options.env ?? { PATH: empty.path }
      const base = Layer.mergeAll(
        Config.testLayer(options.entries ?? []),
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location({ directory }, { projectDirectory: AbsolutePath.make(options.worktree?.(tmp.path) ?? tmp.path) }),
          ),
        ),
        Layer.mock(Bus.Service, {
          publish: (definition, data) =>
            Effect.sync(() => {
              harness.events.push(definition.type)
              // The runtime ignores the returned envelope.
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              return { type: definition.type, data } as never
            }),
        }),
        Global.layerWith({ bin: harness.bin, home: empty.path }),
        Layer.succeed(
          Npm.Service,
          Npm.Service.of({
            add: (pkg) => Effect.succeed({ directory: "", name: pkg }),
            resolve: (pkg) => Effect.succeed({ directory: "", name: pkg }),
            check: () => Effect.succeed(false),
            update: (pkg) => Effect.succeed({ directory: "", name: pkg }),
            which: (pkg, bin) => Effect.sync(() => void harness.npm.push(bin ? `${pkg}:${bin}` : pkg)).pipe(Effect.as(undefined)),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => void harness.http.push(request.url)).pipe(
              Effect.andThen(Effect.die(new Error(`test attempted network request: ${request.url}`))),
            ),
          ),
        ),
        LayerNode.compile(FSUtil.node),
        Layer.effect(
          AppProcess.Service,
          Effect.gen(function* () {
            const processes = yield* AppProcess.Service
            return AppProcess.Service.of({
              ...processes,
              run: (command, runOptions) => {
                harness.processes.push(command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "piped")
                return processes.run(command, runOptions)
              },
            })
          }),
        ).pipe(Layer.provide(LayerNode.compile(AppProcess.node))),
        hostEnvironmentLayer,
      )
      return LSP.layer({
        flags: { disableDownload: false, experimentalTy: false, ...options.flags },
        env,
        builtIns: options.builtIns,
        idleTimeToLive: options.idleTimeToLive,
        sweepInterval: options.sweepInterval,
        maxClients: options.maxClients,
      }).pipe(Layer.provideMerge(base))
    }),
  )
  return { layer, harness: harness as Harness }
}
