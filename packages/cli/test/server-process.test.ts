import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerProcess } from "../src/server-process"
import { isolatedEnv } from "./fixture/environment"

// The project-config gate is tri-state. With no environment variable set the operator's
// `trusted-roots` declaration decides: an absent or empty file is closed, so a repository's own
// config is not discovered unless the operator named its root. An explicit OPENCODE_CONFIG_PROJECT_DISABLE=0
// or =false (case-insensitive and trimmed, or the OPENCODE_DISABLE_PROJECT_CONFIG alias) keeps the
// historical unbounded behavior. Every other value hard-closes discovery, and the primary name wins
// whenever it is set. Declaration lines that are relative, glob-shaped, or `~`-prefixed are ignored
// with a reason instead of being guessed at.
const closed = { all: false, roots: [] }

test.each([
  {
    name: "unset with no declaration",
    env: {},
    expected: { project: true, trust: closed, ignored: [] },
  },
  {
    name: "unset with a declared root",
    env: {},
    declaration: "/repo\n",
    expected: { project: true, trust: { all: false, roots: ["/repo"] }, ignored: [] },
  },
  {
    name: "unset skips comments and blank lines",
    env: {},
    declaration: "# operator declaration\n\n/repo\n",
    expected: { project: true, trust: { all: false, roots: ["/repo"] }, ignored: [] },
  },
  {
    name: "unset reports a relative line",
    env: {},
    declaration: "relative/path\n/repo\n",
    expected: {
      project: true,
      trust: { all: false, roots: ["/repo"] },
      ignored: [{ line: 1, reason: "not an absolute path" }],
    },
  },
  {
    name: "unset reports a glob line",
    env: {},
    declaration: "/repo/*\n",
    expected: {
      project: true,
      trust: closed,
      ignored: [{ line: 1, reason: "glob patterns are not supported" }],
    },
  },
  {
    name: "unset reports a tilde line",
    env: {},
    declaration: "~/dev\n",
    expected: {
      project: true,
      trust: closed,
      ignored: [{ line: 1, reason: "tilde expansion is not supported" }],
    },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=0 keeps the unbounded escape",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "0" },
    declaration: "/repo\n",
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=false",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "false" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=FALSE",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "FALSE" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE= false ",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: " false " },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE empty",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=yes",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "yes" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=on",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "on" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=no",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "no" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=off",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "off" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=2",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "2" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=1 hard-closes even with a declaration",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "1" },
    declaration: "~/dev\n",
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_CONFIG_PROJECT_DISABLE=true",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "true" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_DISABLE_PROJECT_CONFIG=0",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_DISABLE_PROJECT_CONFIG=false",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "false" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "OPENCODE_DISABLE_PROJECT_CONFIG=1",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "OPENCODE_DISABLE_PROJECT_CONFIG=yes",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "yes" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "primary 0 with alias 1",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
  {
    name: "primary 1 with alias 0",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "empty primary with alias 0",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_PROJECT_CONFIG: "0" },
    expected: { project: false, trust: closed, ignored: [] },
  },
  {
    name: "primary false with alias yes",
    env: { OPENCODE_CONFIG_PROJECT_DISABLE: "false", OPENCODE_DISABLE_PROJECT_CONFIG: "yes" },
    expected: { project: true, trust: { all: true, roots: [] }, ignored: [] },
  },
])("project config gate with $name", ({ env, declaration, expected }) => {
  expect(ServerProcess.projectConfigGate(env, declaration)).toEqual(expected)
})

// The pure helper is not enough: the CLI must read the operator's declaration from the global config
// dir and pass both the gate result and the parsed declaration into the server options. This runs
// ServerProcess.run in a fixture process with the server start mocked, so a call site that stops
// consulting the gate (or drops the declaration) fails here while every helper assertion above stays
// green. The fixture prints only the captured config.project and config.trust values.
test("ServerProcess.run passes the gate result and the declaration as config.project and config.trust", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-server-process-gate-"))
  try {
    const config = path.join(root, "config")
    const declared = path.join(root, "declared-repo")
    await mkdir(config, { recursive: true })
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixture/server-process-project-gate.ts"),
        JSON.stringify({
          unset: {},
          declared: { declaration: `${declared}\n` },
          declaredNoise: { declaration: `# comment\nrelative\n${declared}\n` },
          hardClose: { env: { OPENCODE_CONFIG_PROJECT_DISABLE: "1" }, declaration: `${declared}\n` },
          trapYes: { env: { OPENCODE_CONFIG_PROJECT_DISABLE: "yes" } },
          trapEmpty: { env: { OPENCODE_CONFIG_PROJECT_DISABLE: "" } },
          optIn: { env: { OPENCODE_CONFIG_PROJECT_DISABLE: "0" }, declaration: `${declared}\n` },
          alias: { env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" } },
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
    const results = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      { project: boolean | undefined; trust: unknown }
    >
    expect(results.unset).toEqual({ project: true, trust: closed })
    expect(results.declared).toEqual({ project: true, trust: { all: false, roots: [declared] } })
    expect(results.declaredNoise).toEqual({ project: true, trust: { all: false, roots: [declared] } })
    expect(results.hardClose).toEqual({ project: false, trust: closed })
    expect(results.trapYes).toEqual({ project: false, trust: closed })
    expect(results.trapEmpty).toEqual({ project: false, trust: closed })
    expect(results.optIn).toEqual({ project: true, trust: { all: true, roots: [] } })
    expect(results.alias).toEqual({ project: true, trust: { all: true, roots: [] } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
