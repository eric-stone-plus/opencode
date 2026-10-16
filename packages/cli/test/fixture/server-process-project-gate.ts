// Probes the CLI's project-config wiring without starting a server. `start` is mocked to capture the
// options `ServerProcess.run` builds, and each argv case reports the resulting config.project and
// config.trust, so a change that reopens the gate or drops the operator's declaration at the call
// site fails the caller's assertions. Runs in its own process because `mock.module` would otherwise
// leak into the other CLI test files.
import { mock } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const captured: { project: boolean | undefined; trust: unknown } = { project: undefined, trust: undefined }
mock.module("@opencode/server/process", () => ({
  start: (options: { config?: { project?: boolean; trust?: unknown } }) => {
    captured.project = options.config?.project
    captured.trust = options.config?.trust
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

type Case = { env?: Record<string, string | undefined>; declaration?: string }
const cases = JSON.parse(process.argv[2] ?? "{}") as Record<string, Case>
const results: Record<string, { project: boolean | undefined; trust: unknown }> = {}
// The declaration lives in the global config dir the CLI resolves through Global.layerWith.
const declarationPath = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "trusted-roots")
for (const [name, testCase] of Object.entries(cases)) {
  delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  for (const [key, value] of Object.entries(testCase.env ?? {})) {
    if (value !== undefined) process.env[key] = value
  }
  if (testCase.declaration === undefined) await rm(declarationPath, { force: true })
  else {
    await mkdir(path.dirname(declarationPath), { recursive: true })
    await writeFile(declarationPath, testCase.declaration)
  }
  captured.project = undefined
  captured.trust = undefined
  await Effect.runPromise(ServerProcess.run({ mode: "stdio" }))
  results[name] = { project: captured.project, trust: captured.trust }
}
console.log(JSON.stringify(results))
