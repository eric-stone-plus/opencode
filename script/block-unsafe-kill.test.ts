import { describe, expect, test } from "bun:test"
import path from "node:path"
import { registerPlugin, runBattery } from "../bootstrap/agent-hooks/run-cases"

// The kill-guard plugin against the V2 hook shape. The parity battery (cases.json through the
// bash twin and through this plugin) is the real regression net; the tests below pin what the
// battery cannot see: which hooks the plugin registers, which tools it scans, and the denial text.

const pluginPath = path.join(import.meta.dir, "..", "bootstrap", "plugin", "block-unsafe-kill.ts")

const hooks = await registerPlugin(pluginPath)
const before = hooks.get("execute.before")
if (!before) throw new Error("block-unsafe-kill registered no execute.before hook")

const event = (tool: string, input: unknown) => ({
  tool,
  sessionID: "ses_killguard",
  agent: "build",
  messageID: "msg_killguard",
  id: "call_killguard",
  input,
})

async function denial(tool: string, input: unknown) {
  try {
    await before?.(event(tool, input))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

describe("block-unsafe-kill plugin", () => {
  test("bash twin and V2 plugin agree with cases.json", async () => {
    const results = await runBattery(pluginPath)
    expect(results.flatMap((result) => result.failures)).toEqual([])
    const [bash, plugin] = results
    expect(bash.impl).toBe("bash hook")
    expect(plugin.impl).toBe("TS plugin")
    // Only the stdin-protocol cases are bash-only; every other case runs on both sides.
    expect(plugin.pass + plugin.skip).toBe(bash.pass)
    expect(plugin.pass).toBeGreaterThan(150)
  }, 120_000)

  test("registers exactly one execute.before hook", () => {
    expect([...hooks.keys()]).toEqual(["execute.before"])
  })

  test("denies pkill -f on the shell tool with the V1 message and the fix recipes", async () => {
    const message = await denial("shell", { command: "pkill -f node server.js" })
    expect(message).toStartWith("Blocked: pkill -f matches the full cmdline of every process")
    expect(message).toContain("Do NOT retry the same shape")
    expect(message).toContain("Full rules: ~/.config/opencode/AGENTS.md")
  })

  test("denies cgroup_cleanup as a live command and spares mentions of it", async () => {
    const message = await denial("shell", { command: "python -m gateway.cgroup_cleanup" })
    expect(message).toStartWith("Blocked: gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup")
    expect(await denial("shell", { command: "bash -c 'cgroup_cleanup'" })).toStartWith("Blocked: gateway.cgroup_cleanup")
    expect(await denial("shell", { command: "xargs cgroup_cleanup < pids" })).toStartWith("Blocked: gateway.cgroup_cleanup")
    expect(await denial("shell", { command: "vim cgroup_cleanup.md" })).toBeUndefined()
    expect(await denial("shell", { command: "grep -rn cgroup_cleanup docs" })).toBeUndefined()
    expect(await denial("shell", { command: 'git commit -m "document cgroup_cleanup"' })).toBeUndefined()
  })

  test("keeps the read-only and git-commit exemptions", async () => {
    expect(await denial("shell", { command: 'grep -rn "pkill -f" ~/.config' })).toBeUndefined()
    expect(await denial("shell", { command: 'git commit -m "fix pkill -f handling"' })).toBeUndefined()
    expect(await denial("shell", { command: 'echo "$(pkill -f x)"' })).toStartWith("Blocked:")
  })

  test("scans the shell tool and its V1 alias only", async () => {
    expect(await denial("shell", { command: "pkill -f x" })).toStartWith("Blocked:")
    expect(await denial("bash", { command: "pkill -f x" })).toStartWith("Blocked:")
    expect(await denial("edit", { command: "pkill -f x" })).toBeUndefined()
    expect(await denial("read", { path: "pkill -f x" })).toBeUndefined()
  })

  test("ignores shell input that carries no command string", async () => {
    expect(await denial("shell", {})).toBeUndefined()
    expect(await denial("shell", { command: 42 })).toBeUndefined()
    expect(await denial("shell", null)).toBeUndefined()
    expect(await denial("shell", "pkill -f x")).toBeUndefined()
  })
})
