import { Context, Layer } from "effect"

// Fork stub (docs/adr/0001-source-built-binary-no-self-upgrade.md): this binary is built from source and
// must never replace itself. The service survives only because the CLI Runtime typings still name it; it
// has no operations, so nothing here can reach the network or the filesystem.
export interface Interface {
  readonly enabled: false
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export const layer = Layer.succeed(Service, Service.of({ enabled: false }))

export * as Updater from "./updater"
