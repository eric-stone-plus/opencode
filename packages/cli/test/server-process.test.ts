import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerProcess } from "../src/server-process"
import { isolatedEnv } from "./fixture/environment"

// The project-config gate is closed by default: with no environment variable set a
// repository's own config must not be discovered. Only an explicit opt-out of the disable
// opens it — OPENCODE_CONFIG_PROJECT_DISABLE=0 or =false, case-insensitive and trimmed (or
// the OPENCODE_DISABLE_PROJECT_CONFIG alias). Every other value stays closed, including the
// empty string and the yes/on spellings a reader may mistake for the disable itself; the
// primary name wins whenever it is set.
test.each([
  { name: "no environment variables", env: {}, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=0", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "0" }, expected: true },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=false", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "false" }, expected: true },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=FALSE", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "FALSE" }, expected: true },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE= false ",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: " false " },
    expected: true,
  },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE empty", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=yes", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "yes" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=on", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "on" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=no", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "no" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=off", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "off" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=2", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "2" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=1", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "1" }, expected: false },
  { name: "OPENCODE_CONFIG_PROJECT_DISABLE=true", env: { OPENCODE_CONFIG_PROJECT_DISABLE: "true" }, expected: false },
  { name: "OPENCODE_DISABLE_PROJECT_CONFIG=0", env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" }, expected: true },
  {
    name: "OPENCODE_DISABLE_PROJECT_CONFIG=false",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "false" },
    expected: true,
  },
  { name: "OPENCODE_DISABLE_PROJECT_CONFIG=1", env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, expected: false },
  { name: "OPENCODE_DISABLE_PROJECT_CONFIG=yes", env: { OPENCODE_DISABLE_PROJECT_CONFIG: "yes" }, expected: false },
  {
    name: "primary 0 with alias 1",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    expected: true,
  },
  {
    name: "primary 1 with alias 0",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    expected: false,
  },
  {
    name: "empty primary with alias 0",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    expected: false,
  },
  {
    name: "primary false with alias yes",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "false", OPENCODE_DISABLE_PROJECT_CONFIG: "yes" },
    expected: true,
  },
])("project config gate with $name", ({ env, expected }) => {
  expect(ServerProcess.projectConfigEnabled(env)).toBe(expected)
})

// The pure helper is not enough: the CLI must pass its result into the server options. This runs
// ServerProcess.run in a fixture process with the server start mocked, so a call site that stops
// consulting the fail-closed gate (for example reverting to `!truthy(...)`) fails here while every
// helper assertion above stays green. The fixture prints only the captured config.project values.
test("ServerProcess.run passes the fail-closed gate result as config.project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-server-process-gate-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixture/server-process-project-gate.ts"),
        JSON.stringify({
          unset: {},
          optIn: { OPENCODE_CONFIG_PROJECT_DISABLE: "0" },
          optInFalse: { OPENCODE_CONFIG_PROJECT_DISABLE: "false" },
          trapYes: { OPENCODE_CONFIG_PROJECT_DISABLE: "yes" },
          trapEmpty: { OPENCODE_CONFIG_PROJECT_DISABLE: "" },
          alias: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
        }),
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: isolatedEnv(root, { OPENCODE_PASSWORD: undefined, OPENCODE_SERVER_PASSWORD: undefined }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`project gate probe failed: ${stderr}`)
    const flags = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, boolean | undefined>
    expect(flags.unset).toBe(false)
    expect(flags.optIn).toBe(true)
    expect(flags.optInFalse).toBe(true)
    expect(flags.trapYes).toBe(false)
    expect(flags.trapEmpty).toBe(false)
    expect(flags.alias).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
