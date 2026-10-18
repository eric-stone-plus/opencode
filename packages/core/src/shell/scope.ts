export * as ShellScope from "./scope.js"

import { Duration, Effect, Exit } from "effect"
import { ChildProcess } from "effect/process"
import { AppProcess } from "@opencode/util/process"
import { which } from "../util/which.js"

// A transient user scope gives every shell command a cgroup boundary. Killing the unit kills every
// descendant, including processes that escape the process group with setsid()/setpgid(), such as
// Flatpak's bwrap. systemd-run execs the command in place, so the handle pid, exit code and stdio
// stay those of the command.
export const UNIT_PREFIX = "opencode-shell-"
const STOP_GRACE = "3s"
const PROBE_TIMEOUT = Duration.seconds(3)
const STOP_TIMEOUT = Duration.seconds(5)
const systemdRun = () => which("systemd-run") ?? "systemd-run"
const systemctl = () => which("systemctl") ?? "systemctl"

const unitName = (unit: string) => (unit.endsWith(".scope") ? unit : `${unit}.scope`)

// systemd-run only accepts --expand-environment since v254. Without it, `${VAR}` is expanded by
// systemd from the wrong environment and `$$` collapses to a literal `$`, so the scope is skipped
// entirely on older systemd rather than corrupting commands.
const scopeArgs = (unit: string, command: string, args: readonly string[]) => [
  "--user",
  "--scope",
  "--collect",
  "--quiet",
  "--expand-environment=no",
  `--property=TimeoutStopSec=${STOP_GRACE}`,
  "--property=KillMode=control-group",
  `--unit=${unitName(unit)}`,
  "--",
  command,
  ...args,
]

export interface Wrapped {
  readonly command: string
  readonly args: readonly string[]
  readonly unit?: string
  readonly stop: Effect.Effect<void>
}

export interface Interface {
  readonly active: boolean
  readonly wrap: (input: {
    readonly command: string
    readonly args: readonly string[]
    readonly unit: string
  }) => Wrapped
}

const stop = (app: AppProcess.Interface, unit: string) =>
  app
    .run(ChildProcess.make(systemctl(), ["--user", "stop", unit], { stdin: "ignore" }), {
      timeout: STOP_TIMEOUT,
    })
    .pipe(Effect.ignoreCause)

const probe = (app: AppProcess.Interface) => {
  // The scope is only useful when it can also be stopped again.
  if (which("systemctl") === undefined) return Effect.succeed(false)
  return app
    .run(
      ChildProcess.make(
        systemdRun(),
        scopeArgs(`${UNIT_PREFIX}probe-${crypto.randomUUID()}`, "true", []),
        { stdin: "ignore" },
      ),
      { timeout: PROBE_TIMEOUT },
    )
    .pipe(
      Effect.exit,
      Effect.map((exit) => Exit.isSuccess(exit) && exit.value.exitCode === 0),
    )
}

export const make = (
  app: AppProcess.Interface,
  options?: { readonly detect?: Effect.Effect<boolean> },
): Effect.Effect<Interface> =>
  Effect.map(options?.detect ?? probe(app), (active) => ({
    active,
    wrap: (input) => {
      if (!active) return { command: input.command, args: input.args, stop: Effect.void }
      // systemd-run accepts a bare --unit name and appends .scope, but systemctl needs the full
      // unit name; keep one canonical name so stop always addresses the scope that was started.
      const unit = unitName(input.unit)
      return {
        command: systemdRun(),
        args: scopeArgs(unit, input.command, input.args),
        unit,
        stop: stop(app, unit),
      }
    },
  }))

// Session environments replace process.env, so the user manager connection can be missing even
// though systemd-run itself is available. Only fill in values the invocation did not set.
export const environment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const result = { ...env }
  if (result.XDG_RUNTIME_DIR === undefined && process.env.XDG_RUNTIME_DIR !== undefined)
    result.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  if (result.DBUS_SESSION_BUS_ADDRESS === undefined && process.env.DBUS_SESSION_BUS_ADDRESS !== undefined)
    result.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS
  return result
}
