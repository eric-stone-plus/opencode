// Probes the CLI's project-config wiring without starting a server. `start` is mocked to capture the
// options `ServerProcess.run` builds, and each argv case reports the resulting config.project, so a
// change that reopens the gate at the call site fails the caller's assertions. Runs in its own process
// because `mock.module` would otherwise leak into the other CLI test files.
import { mock } from "bun:test"
import { Effect } from "effect"

const captured: { project: boolean | undefined } = { project: undefined }
mock.module("@opencode/server/process", () => ({
  start: (options: { config?: { project?: boolean } }) => {
    captured.project = options.config?.project
    return Effect.succeed(undefined)
  },
}))

const { ServerProcess } = await import("../../src/server-process")

// Fail before running anything if the module mock did not apply: without it, `run` would start a
// real server. Calling `start` only constructs its Effect, so this probe cannot bind a port.
const probe = await import("@opencode/server/process")
probe.start({ config: { project: true } } as never)
if (captured.project !== true) throw new Error("server start was not intercepted")
captured.project = undefined

const cases = JSON.parse(process.argv[2] ?? "{}") as Record<string, Record<string, string | undefined>>
const results: Record<string, boolean | undefined> = {}
for (const [name, overrides] of Object.entries(cases)) {
  delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value
  }
  captured.project = undefined
  await Effect.runPromise(ServerProcess.run({ mode: "stdio" }))
  results[name] = captured.project
}
console.log(JSON.stringify(results))
