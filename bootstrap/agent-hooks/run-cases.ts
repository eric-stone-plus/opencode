#!/usr/bin/env bun
// Regression battery shared by the bash guard and the opencode plugin port.
// Exercises BOTH implementations on every case: the bash hook through its
// stdin JSON protocol, the V2 plugin through the `execute.before` hook it
// registers on the tool domain. Fails LOUDLY (red output + nonzero exit) when
// cases.json is missing, jq is missing (the bash hook then runs degraded), or
// a case run crashes — the battery must never go green while the guard is
// degraded.
// Run after every edit of either implementation:
//   bun ~/.config/agent-hooks/run-cases.ts [plugin-path]
// `runBattery` is also what script/block-unsafe-kill.test.ts calls.
import { readFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

const RED = "\x1b[31m"
const RESET = "\x1b[0m"

export class HarnessError extends Error {}
function die(msg: string): never {
  throw new HarnessError(msg)
}

const here = new URL(".", import.meta.url).pathname
// Deployed layout: ~/.config/agent-hooks/ next to ~/.config/opencode/plugin/.
// Repo layout: bootstrap/agent-hooks/ next to bootstrap/plugin/. Resolve both
// so the battery is runnable from a checkout, not just from the seat.
const pluginCandidates = [`${here}../opencode/plugin/block-unsafe-kill.ts`, `${here}../plugin/block-unsafe-kill.ts`]
const hookPath = `${here}block-unsafe-kill.sh`
const casesPath = `${here}cases.json`

type Verdict = "block" | "allow" | "crash" | "skip"
type Case = { label: string; cmd: string; expect: "block" | "allow"; raw?: boolean }

// The V2 plugin registers its guard on `ctx.tool`; the battery stands in for the host with
// just that capability and keeps the registered callbacks, so a hook runs with the same event
// object shape the runtime hands it (readonly identity fields + mutable `tool` and `input`).
export type Hook = (event: unknown) => unknown
export async function registerPlugin(pluginPath: string) {
  const plugin = (await import(pluginPath)).default
  if (typeof plugin?.setup !== "function") die(`TS plugin at ${pluginPath} has no setup(ctx)`)
  const hooks = new Map<string, Hook>()
  await plugin.setup({
    tool: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  })
  return hooks
}

// The bash hook protocol: event JSON on stdin, deny = exit 2. Any other
// nonzero exit (signal, `set -u` blowup) is a crash, never an allow.
function bashVerdict(cmd: string, raw: boolean): Verdict {
  const input = raw ? cmd : JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } })
  const proc = spawnSync("bash", [hookPath], { input, encoding: "utf8" })
  if (proc.status === 2) return "block"
  if (proc.status === 0) return "allow"
  return "crash"
}

// The plugin denies by throwing `Blocked: …`; any other throw is a crash.
async function tsVerdict(before: Hook, tool: string, input: unknown): Promise<Verdict> {
  try {
    await before({
      tool,
      sessionID: "ses_battery",
      agent: "build",
      messageID: "msg_battery",
      id: "call_battery",
      input,
    })
    return "allow"
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return msg.startsWith("Blocked:") ? "block" : "crash"
  }
}

export type BatteryResult = {
  impl: "bash hook" | "TS plugin"
  pass: number
  fail: number
  skip: number
  failures: string[]
}

export async function runBattery(pluginArg?: string): Promise<BatteryResult[]> {
  const pluginPath = pluginArg ?? pluginCandidates.find((candidate) => existsSync(candidate)) ?? pluginCandidates[0]
  if (!existsSync(casesPath)) die(`cases.json missing at ${casesPath}`)
  if (!existsSync(hookPath)) die(`bash hook missing at ${hookPath}`)
  if (!existsSync(pluginPath)) die(`TS plugin missing at ${pluginPath}`)
  if (spawnSync("jq", ["--version"], { encoding: "utf8" }).error)
    die("jq missing — the bash hook guard is degraded (it warns and passes without jq)")

  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[]
  if (cases.length === 0) die("cases.json has no cases")
  const before = (await registerPlugin(pluginPath)).get("execute.before")
  if (!before) die("TS plugin registered no execute.before hook")

  const rows: Array<{
    label: string
    expect: "block" | "allow"
    bash: () => Verdict
    ts: () => Promise<Verdict>
  }> = cases.map((c) => ({
    label: c.label,
    expect: c.expect,
    bash: () => bashVerdict(c.cmd, c.raw === true),
    // the stdin-protocol cases (malformed JSON, empty stdin, foreign
    // tool_name) only exist on the bash side — the TS plugin has no stdin
    // protocol and always receives a structured event — so TS skips them.
    ts: c.raw ? async (): Promise<Verdict> => "skip" : () => tsVerdict(before, "shell", { command: c.cmd }),
  }))

  rows.push(
    {
      label: "non-shell tool ignored",
      expect: "allow",
      bash: () => bashVerdict(JSON.stringify({ tool_name: "Edit", tool_input: { command: "pkill -f x" } }), true),
      ts: () => tsVerdict(before, "edit", { command: "pkill -f x" }),
    },
    {
      label: "V1 tool name bash is still scanned",
      expect: "block",
      bash: () => bashVerdict(JSON.stringify({ tool_name: "bash", tool_input: { command: "pkill -f x" } }), true),
      ts: () => tsVerdict(before, "bash", { command: "pkill -f x" }),
    },
    {
      label: "shell input without a command string is ignored",
      expect: "allow",
      bash: () => bashVerdict(JSON.stringify({ tool_name: "Bash", tool_input: {} }), true),
      ts: () => tsVerdict(before, "shell", { command: 42 }),
    },
  )

  const results: BatteryResult[] = []
  for (const impl of ["bash hook", "TS plugin"] as const) {
    const result: BatteryResult = { impl, pass: 0, fail: 0, skip: 0, failures: [] }
    for (const row of rows) {
      const got = impl === "bash hook" ? row.bash() : await row.ts()
      if (got === "skip") {
        result.skip++
        continue
      }
      if (got === "crash") {
        result.fail++
        result.failures.push(`FAIL ${impl}  crash  ${row.label}`)
        continue
      }
      if (got === row.expect) result.pass++
      else {
        result.fail++
        result.failures.push(`FAIL ${impl}  want=${row.expect} got=${got}  ${row.label}`)
      }
    }
    results.push(result)
  }
  return results
}

if (import.meta.main) {
  const results = await runBattery(process.argv[2]).catch((error: unknown) => {
    if (!(error instanceof HarnessError)) throw error
    console.error(`${RED}HARNESS FAIL: ${error.message}${RESET}`)
    process.exit(1)
  })
  for (const result of results) {
    for (const line of result.failures) console.log(`${RED}${line}${RESET}`)
    console.log(
      `${result.impl}: cases: ${result.pass + result.fail}, pass: ${result.pass}, fail: ${result.fail}` +
        (result.skip > 0 ? `, skip: ${result.skip} (bash stdin-protocol only)` : ""),
    )
  }
  process.exit(results.every((result) => result.fail === 0) ? 0 : 1)
}
