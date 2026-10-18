import path from "path"
import fs from "fs"
import os from "os"
import { Context, Effect, Layer } from "effect"
// XDG on runtimes with a home directory; one tmp-rooted directory on workerd.
// The variants resolve through the `workerd` bundle condition, like the
// native-module stubs, so no runtime sniffing happens here.
import { roots } from "#global-roots"
import { Flock } from "./flock.js"
import { makeGlobalNode } from "./effect/app-node.js"

const app = "opencode"
const { data, cache, config, state, tmp } = roots(app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  // The acquired service canonicalizes default tmp; use it instead of Path.tmp for path comparisons.
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: input.tmp ?? Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const acquire = (input: Partial<Interface>) =>
  Effect.gen(function* () {
    const service = Service.of(make(input))
    // Session data and logs are private; other service directories keep their historical modes.
    const privateDirectories = new Set([service.data, service.log])
    yield* Effect.promise(() =>
      Promise.all(
        [service.data, service.config, service.state, service.log, service.bin, service.repos, service.tmp].map(
          (directory) =>
            fs.promises.mkdir(directory, {
              recursive: true,
              ...(privateDirectories.has(directory) ? { mode: 0o700 } : {}),
            }),
        ),
      ),
    )
    // mkdir leaves an existing directory's mode untouched, so older installs stay world-readable
    // until they are tightened here. Windows inherits ACLs from the user profile directory.
    // Never chmod the OS temp root itself (tests configure it as a scratch data/log directory and
    // it is shared), and never let one chmod failure break startup.
    const temp = os.tmpdir()
    const tighten = (directory: string) =>
      process.platform !== "win32" && directory !== temp
        ? fs.promises.chmod(directory, 0o700).catch(() => undefined)
        : Promise.resolve()
    yield* Effect.promise(() => Promise.all(Array.from(privateDirectories, tighten)))
    // The async realpath is what the service payload test and the rest of the flow compare against; the
    // sync call expands more on Windows (the profile's 8.3 short name), which puts the two out of step.
    const canonicalTmp = yield* Effect.promise(() => fs.promises.realpath(service.tmp))
    return Service.of({ ...service, tmp: input.tmp ?? canonicalTmp })
  })

const layer = Layer.effect(
  Service,
  Effect.suspend(() => acquire({ config: process.env.OPENCODE_CONFIG_DIR ?? Path.config })),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, acquire(input))

export * as Global from "./global.js"
