#!/usr/bin/env bun
// Regression battery shared by the bash guard and the opencode plugin port.
// Exercises BOTH implementations on every case: the bash hook through its
// stdin JSON protocol, the TS plugin through its tool.execute.before hook.
// Fails LOUDLY (red output + nonzero exit) when cases.json is missing, jq is
// missing (the bash hook then runs degraded), or a case run crashes — the
// battery must never go green while the guard is degraded.
// Run after every edit of either implementation:
//   bun ~/.config/agent-hooks/run-cases.ts [plugin-path]
import { readFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

const RED = "\x1b[31m"
const RESET = "\x1b[0m"
const die = (msg: string): never => {
  console.error(`${RED}HARNESS FAIL: ${msg}${RESET}`)
  process.exit(1)
}

const here = new URL(".", import.meta.url).pathname
const pluginPath = process.argv[2] ?? `${here}../opencode/plugin/block-unsafe-kill.ts`
const hookPath = `${here}block-unsafe-kill.sh`
const casesPath = `${here}cases.json`

if (!existsSync(casesPath)) die(`cases.json missing at ${casesPath}`)
if (!existsSync(hookPath)) die(`bash hook missing at ${hookPath}`)
if (!existsSync(pluginPath)) die(`TS plugin missing at ${pluginPath}`)
if (spawnSync("jq", ["--version"], { encoding: "utf8" }).error)
  die("jq missing — the bash hook guard is degraded (it warns and passes without jq)")

const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Array<{
  label: string
  cmd: string
  expect: "block" | "allow"
  raw?: boolean
}>
if (cases.length === 0) die("cases.json has no cases")

const factory = (await import(pluginPath)).default
const hooks = await factory({})
const before = hooks["tool.execute.before"] as (
  input: { tool: string },
  output: { args: { command: string } },
) => Promise<void>

type Verdict = "block" | "allow" | "crash" | "skip"

// The bash hook protocol: event JSON on stdin, deny = exit 2. Any other
// nonzero exit (signal, `set -u` blowup) is a crash, never an allow.
function bashVerdict(cmd: string, raw: boolean): Verdict {
  const input = raw
    ? cmd
    : JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } })
  const proc = spawnSync("bash", [hookPath], { input, encoding: "utf8" })
  if (proc.status === 2) return "block"
  if (proc.status === 0) return "allow"
  return "crash"
}

// The plugin denies by throwing `Blocked: …`; any other throw is a crash.
async function tsVerdict(tool: string, cmd: string): Promise<Verdict> {
  try {
    await before({ tool }, { args: { command: cmd } })
    return "allow"
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return msg.startsWith("Blocked:") ? "block" : "crash"
  }
}

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
  // protocol and opencode always supplies input.tool — so TS skips them.
  ts: c.raw ? async (): Promise<Verdict> => "skip" : () => tsVerdict("bash", c.cmd),
}))

rows.push({
  label: "non-bash tool ignored",
  expect: "allow",
  bash: () =>
    bashVerdict(JSON.stringify({ tool_name: "Edit", tool_input: { command: "pkill -f x" } }), true),
  ts: () => tsVerdict("edit", "pkill -f x"),
})

let totalFail = 0
for (const impl of ["bash hook", "TS plugin"] as const) {
  let pass = 0
  let fail = 0
  let skip = 0
  for (const row of rows) {
    const got = impl === "bash hook" ? row.bash() : await row.ts()
    if (got === "skip") {
      skip++
      continue
    }
    if (got === "crash") {
      fail++
      console.log(`${RED}FAIL ${impl}  crash  ${row.label}${RESET}`)
      continue
    }
    if (got === row.expect) pass++
    else {
      fail++
      console.log(`${RED}FAIL ${impl}  want=${row.expect} got=${got}  ${row.label}${RESET}`)
    }
  }
  totalFail += fail
  console.log(
    `${impl}: cases: ${pass + fail}, pass: ${pass}, fail: ${fail}` +
      (skip > 0 ? `, skip: ${skip} (bash stdin-protocol only)` : ""),
  )
}
process.exit(totalFail === 0 ? 0 : 1)
