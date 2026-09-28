#!/usr/bin/env bun
// Regression battery for the opencode plugin port, sharing cases.json with the
// bash guard. Run after every edit of the plugin:
//   bun ~/.config/agent-hooks/run-cases.ts [plugin-path]
import { readFileSync } from "node:fs"

const here = new URL(".", import.meta.url).pathname
const pluginPath = process.argv[2] ?? `${here}../opencode/plugin/block-unsafe-kill.ts`
const cases = JSON.parse(readFileSync(`${here}cases.json`, "utf8")) as Array<{
  label: string
  cmd: string
  expect: "block" | "allow"
  raw?: boolean
}>

const factory = (await import(pluginPath)).default
const hooks = await factory({})
const before = hooks["tool.execute.before"] as (
  input: { tool: string },
  output: { args: { command: string } },
) => Promise<void>

let pass = 0
let fail = 0
const check = (label: string, expect: string, run: () => Promise<void>) => {
  return run().then(
    () => {
      if (expect === "allow") pass++
      else { fail++; console.log(`FAIL want=block got=allow  ${label}`) }
    },
    () => {
      if (expect === "block") pass++
      else { fail++; console.log(`FAIL want=allow got=block  ${label}`) }
    },
  )
}

for (const c of cases) {
  if (c.raw) continue // stdin-protocol cases only apply to the bash guard
  await check(c.label, c.expect, () =>
    before({ tool: "bash" }, { args: { command: c.cmd } }))
}
await check("non-bash tool ignored", "allow", () =>
  before({ tool: "edit" }, { args: { command: "pkill -f x" } }))

console.log(`cases: ${pass + fail}, pass: ${pass}, fail: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
