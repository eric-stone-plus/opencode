// Probes the CLI's project-config wiring without starting a server. `start` is mocked to capture the
// options `ServerProcess.run` builds, and each argv case reports the resulting config.project and
// config.trust, so a change that reopens the gate or drops the operator's declaration at the call
// site fails the caller's assertions. Runs in its own process because `mock.module` would otherwise
// leak into the other CLI test files.
import { mock } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"

const captured: { project: boolean | undefined; trust: unknown; env: string | undefined } = {
  project: undefined,
  trust: undefined,
  env: undefined,
}
mock.module("@opencode/server/process", () => ({
  start: (options: { config?: { project?: boolean; trust?: unknown } }) => {
    captured.project = options.config?.project
    captured.trust = options.config?.trust
    // Read at the last possible moment: this is the environment the server would inherit.
    captured.env = process.env.OPENCODE_CONFIG_PROJECT_DISABLE
    return Effect.succeed(undefined)
  },
}))

const { ServerProcess } = await import("../../src/server-process")
const { ServiceConfig } = await import("../../src/services/service-config")

// This fixture deletes and writes trusted-roots and service config files. Refuse to run against the
// operator's real config directory when the harness forgot to isolate it. The per-case check below
// re-validates the resolved directory because a case can override OPENCODE_CONFIG_DIR.
const isolatedHome = process.env.OPENCODE_TEST_HOME
if (!process.env.OPENCODE_CONFIG_DIR || !isolatedHome) {
  throw new Error("server-process-project-gate requires an isolated OPENCODE_CONFIG_DIR and OPENCODE_TEST_HOME")
}

// Fail before running anything if the module mock did not apply: without it, `run` would start a
// real server. Calling `start` only constructs its Effect, so this probe cannot bind a port.
const probe = await import("@opencode/server/process")
probe.start({ config: { project: true } } as never)
if (captured.project !== true) throw new Error("server start was not intercepted")
captured.project = undefined

type Case = {
  env?: Record<string, string>
  declaration?: string
  mode?: "stdio" | "service"
  service?: { env?: Record<string, string> }
}

const writeOrRemove = async (file: string, contents: string | undefined) => {
  if (contents === undefined) return rm(file, { force: true })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}
const cases = JSON.parse(process.argv[2] ?? "{}") as Record<string, Case>
const results: Record<string, { project: boolean | undefined; trust: unknown; applied?: string }> = {}
for (const [name, testCase] of Object.entries(cases)) {
  const saved = { ...process.env }
  const savedCwd = process.cwd()
  delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  for (const [key, value] of Object.entries(testCase.env ?? {})) process.env[key] = value
  // Mirror ServerProcess.run's Global.layerWith input: an unset variable falls back to the XDG
  // config path, and a relative one is resolved against home rather than the launch cwd.
  const config = Global.make(
    process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {},
  ).config
  const root = path.resolve(isolatedHome)
  if (config !== root && !config.startsWith(root + path.sep)) {
    throw new Error(`server-process-project-gate refuses to modify non-isolated config dir: ${config}`)
  }
  const declarationPath = path.join(config, "trusted-roots")
  const servicePath = path.join(config, ServiceConfig.filename())
  await writeOrRemove(declarationPath, testCase.declaration)
  await writeOrRemove(servicePath, testCase.service === undefined ? undefined : JSON.stringify(testCase.service))
  captured.project = undefined
  captured.trust = undefined
  captured.env = undefined
  try {
    await Effect.runPromise(ServerProcess.run({ mode: testCase.mode ?? "stdio" }))
  } finally {
    // A service config applies its saved env to the process and service mode changes to home;
    // restore both so later cases do not inherit either.
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]
    Object.assign(process.env, saved)
    process.chdir(savedCwd)
  }
  results[name] = {
    project: captured.project,
    trust: captured.trust,
    ...(testCase.mode === "service" && captured.env !== undefined ? { applied: captured.env } : {}),
  }
}
console.log(JSON.stringify(results))
