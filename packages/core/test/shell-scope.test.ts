import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { ShellScope } from "@opencode/core/shell/scope"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const fx = testEffect(LayerNode.compile(AppProcess.node))
const shell = testEffect(
  AppNodeBuilder.build(LayerNode.group([Shell.node, AppProcess.node]), [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(tempGlobalLayer),
    Config.node.replace(Config.testLayer()),
  ]),
)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gone = async (pid: number, timeout = 5_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(25)
  }
  return !alive(pid)
}

const readPid = (file: string) =>
  Effect.promise(async () => {
    while (true) {
      try {
        const text = (await fs.readFile(file, "utf8")).trim()
        if (text) return Number(text)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await Bun.sleep(10)
    }
  })

describe("shell scope", () => {
  fx.effect("wraps a command in a transient user scope", () =>
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const scope = yield* ShellScope.make(app, { detect: Effect.succeed(true) })
      const wrapped = scope.wrap({ command: "/bin/sh", args: ["-c", "echo $$"], unit: "opencode-shell-test" })

      expect(scope.active).toBe(true)
      expect(wrapped.command.endsWith("systemd-run")).toBe(true)
      expect(wrapped.args).toEqual([
        "--user",
        "--scope",
        "--collect",
        "--quiet",
        "--expand-environment=no",
        "--property=TimeoutStopSec=3s",
        "--property=KillMode=control-group",
        "--unit=opencode-shell-test.scope",
        "--",
        "/bin/sh",
        "-c",
        "echo $$",
      ])
      expect(wrapped.unit).toBe("opencode-shell-test.scope")
    }),
  )

  fx.effect("falls back to a direct command when the scope is unavailable", () =>
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const scope = yield* ShellScope.make(app, { detect: Effect.succeed(false) })
      const wrapped = scope.wrap({ command: "/bin/sh", args: ["-c", "printf fallback"], unit: "opencode-shell-test" })

      expect(scope.active).toBe(false)
      expect(wrapped.command).toBe("/bin/sh")
      expect(wrapped.args).toEqual(["-c", "printf fallback"])
      expect(wrapped.unit).toBeUndefined()

      const result = yield* app.run(ChildProcess.make(wrapped.command, wrapped.args))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("fallback")
      yield* wrapped.stop
    }),
  )

  fx.live(
    "stops a scope with setsid and separate process-group descendants",
    () =>
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        const scope = yield* ShellScope.make(app)
        // Hosts without systemd-run or a user manager keep the legacy process-group path.
        if (!scope.active) return
        const tmp = yield* tmpdirScoped()
        const setsidPidFile = path.join(tmp.path, "setsid.pid")
        const groupPidFile = path.join(tmp.path, "group.pid")
        const script = [
          `setsid sh -c 'echo $$ > ${setsidPidFile}; exec sleep 300' &`,
          "set -m",
          `sleep 300 & echo $! > ${groupPidFile}`,
          `while [ ! -s ${setsidPidFile} ] || [ ! -s ${groupPidFile} ]; do sleep 0.05; done`,
          "while :; do sleep 1; done",
        ].join("\n")
        const wrapped = scope.wrap({
          command: "/bin/sh",
          args: ["-c", script],
          unit: `${ShellScope.UNIT_PREFIX}${crypto.randomUUID()}`,
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* app.spawn(
              ChildProcess.make(wrapped.command, wrapped.args, {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
              }),
            )
            const setsidPid = yield* readPid(setsidPidFile)
            const groupPid = yield* readPid(groupPidFile)
            expect(alive(setsidPid)).toBe(true)
            expect(alive(groupPid)).toBe(true)

            yield* wrapped.stop

            expect(yield* Effect.promise(() => gone(setsidPid))).toBe(true)
            expect(yield* Effect.promise(() => gone(groupPid))).toBe(true)
          }),
        )
      }),
    { timeout: 20_000 },
  )

  fx.live(
    "passes shell variables through without systemd expansion",
    () =>
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        const scope = yield* ShellScope.make(app)
        if (!scope.active) return
        const wrapped = scope.wrap({
          command: "/bin/sh",
          args: ["-c", `PROBE=inner; printf '%s|%s' "\${PROBE}" "$$"`],
          unit: `${ShellScope.UNIT_PREFIX}${crypto.randomUUID()}`,
        })

        const result = yield* app.run(ChildProcess.make(wrapped.command, wrapped.args))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toStartWith("inner|")
        // `$$` must reach the shell intact instead of collapsing to a literal `$`.
        expect(result.stdout.toString()).not.toContain("$")
        yield* wrapped.stop
      }),
    { timeout: 20_000 },
  )

  shell.live(
    "kills a setsid descendant when the shell times out",
    () =>
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        if (!(yield* ShellScope.make(app)).active) return
        const tmp = yield* tmpdirScoped()
        const pidFile = path.join(tmp.path, "child.pid")
        const service = yield* Shell.Service
        const info = yield* service.create({
          shell: "/bin/sh",
          command: `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 300' & while [ ! -s ${pidFile} ]; do sleep 0.05; done; sleep 300`,
          timeout: 0,
        })
        const pid = yield* readPid(pidFile)
        expect(alive(pid)).toBe(true)

        yield* service.timeout(info.id, 1)

        expect((yield* service.wait(info.id).pipe(Effect.timeout("20 seconds"))).status).toBe("timeout")
        expect(yield* Effect.promise(() => gone(pid))).toBe(true)
      }),
    { timeout: 30_000 },
  )

  shell.live(
    "kills a setsid descendant after the shell exits",
    () =>
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        if (!(yield* ShellScope.make(app)).active) return
        const tmp = yield* tmpdirScoped()
        const pidFile = path.join(tmp.path, "child.pid")
        const service = yield* Shell.Service
        const info = yield* service.create({
          shell: "/bin/sh",
          command: `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 300' & while [ ! -s ${pidFile} ]; do sleep 0.05; done`,
          timeout: 0,
        })
        const pid = yield* readPid(pidFile)

        expect((yield* service.wait(info.id).pipe(Effect.timeout("20 seconds"))).status).toBe("exited")
        expect(yield* Effect.promise(() => gone(pid))).toBe(true)
      }),
    { timeout: 30_000 },
  )
})
