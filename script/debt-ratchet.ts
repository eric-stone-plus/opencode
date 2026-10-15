// Debt ratchet. The repository's technical-debt markers may only shrink: a change that grows one of
// the counted metrics fails the gate, and rewriting the recorded baseline is how a deliberate
// increase is acknowledged. codewhale's `scripts/ratchet-gate.sh` is the model (borrow item C12);
// this is the fork-local port for a Bun/TS tree.
//
// Usage:
//   bun run debt-ratchet            # compare against script/debt-ratchet.baseline.json
//   bun run debt-ratchet --update   # ratchet the baseline to the current counts
//
// Scope: packages/**/*.{ts,tsx} minus node_modules and generated/ directories plus the two codegen
// database files listed in GENERATED - generated code is regenerated wholesale and would flap the
// gate. The exemption is by path, not by a `*.gen.ts` name: a suffix let any hand-written file dodge
// the ratchet by renaming itself. script/ is out of scope on purpose: the
// counting patterns live there and would count themselves.
//
// Inherited debt: an upstream merge that adds debt fails this gate until `--update` records the new
// baseline, and the printed delta is the review artifact. (codewhale compares against the merge base
// instead; that needs a worktree per check and is not worth the machinery for a solo fork.)

import { Glob } from "bun"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const BASELINE_PATH = "script/debt-ratchet.baseline.json"

export type Metric = { id: string; pattern: RegExp; why: string }
export type Counts = Record<string, number>

export const METRICS: Metric[] = [
  {
    id: "ts-suppressions",
    pattern: /@ts-expect-error|@ts-ignore|@ts-nocheck/g,
    why: "type-suppression comments",
  },
  {
    // Generic slots (`Array<any>`, `Record<string, any>`, `<any, ...>`) and optional slots (`foo?: any`)
    // slipped past the bare `: any | as any` shapes.
    id: "any-usage",
    pattern: /:\s*any\b|as any\b|<any\b|,\s*any\b|extends any\b/g,
    why: "untyped values entering the type system",
  },
  { id: "todo-markers", pattern: /TODO|FIXME|XXX/g, why: "unfinished-work markers" },
]

const SOURCE = ["packages/**/*.ts", "packages/**/*.tsx"]
// Codegen owns exactly these two files (`bun run db:generate`). The exemption is by path, not by a
// `*.gen.ts` name: a suffix let any hand-written file dodge the ratchet by renaming itself.
const GENERATED = new Set(["packages/core/src/database/schema.gen.ts", "packages/core/src/database/migration.gen.ts"])
const EXCLUDED = /(^|\/)node_modules\/|(^|\/)generated\//

export async function countDebt(directory: string): Promise<Counts> {
  const counts: Counts = {}
  for (const metric of METRICS) counts[metric.id] = 0
  for (const pattern of SOURCE) {
    const glob = new Glob(pattern)
    for await (const relative of glob.scan({ cwd: directory })) {
      if (EXCLUDED.test(relative) || GENERATED.has(relative)) continue
      const source = await readFile(path.join(directory, relative), "utf8")
      for (const metric of METRICS) {
        const matches = source.match(metric.pattern)
        counts[metric.id] = (counts[metric.id] ?? 0) + (matches?.length ?? 0)
      }
    }
  }
  return counts
}

export async function readBaseline(directory: string): Promise<Counts> {
  const parsed: unknown = JSON.parse(await readFile(path.join(directory, BASELINE_PATH), "utf8"))
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${BASELINE_PATH}: expected a JSON object`)
  const source = parsed as Record<string, unknown>
  const counts: Counts = {}
  for (const metric of METRICS) {
    const value = source[metric.id]
    if (typeof value !== "number") throw new Error(`${BASELINE_PATH}: missing a number for ${metric.id}`)
    counts[metric.id] = value
  }
  return counts
}

export async function writeBaseline(directory: string, counts: Counts): Promise<void> {
  const ordered: Counts = {}
  for (const metric of METRICS) ordered[metric.id] = counts[metric.id] ?? 0
  const file = path.join(directory, BASELINE_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`, "utf8")
}

export async function checkDebtRatchet(directory: string): Promise<string[]> {
  const current = await countDebt(directory)
  const baseline = await readBaseline(directory)
  const problems: string[] = []
  for (const metric of METRICS) {
    const now = current[metric.id] ?? 0
    const allowed = baseline[metric.id] ?? 0
    if (now > allowed) problems.push(`${metric.id} grew: ${allowed} -> ${now} (${metric.why})`)
  }
  return problems
}

if (import.meta.main) {
  const directory = process.cwd()
  const current = await countDebt(directory)
  if (process.argv.includes("--update")) {
    await writeBaseline(directory, current)
    console.log("debt baseline updated:")
    for (const metric of METRICS) console.log(`  ${metric.id}: ${current[metric.id] ?? 0}`)
  }
  const problems = await checkDebtRatchet(directory)
  for (const metric of METRICS) {
    const baseline = (await readBaseline(directory))[metric.id] ?? 0
    const now = current[metric.id] ?? 0
    const delta = now - baseline
    const marker = delta > 0 ? "GREW" : delta < 0 ? "can shrink" : "ok"
    console.log(`  ${metric.id}: ${baseline} -> ${now} (${marker})`)
  }
  if (problems.length > 0) {
    console.error("debt ratchet failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      "\nPay the debt down, or acknowledge the increase deliberately:\n" +
        `  bun run debt-ratchet --update   # then commit ${BASELINE_PATH} with the change that grew it`,
    )
    process.exit(1)
  }
  console.log("debt ratchet: ok")
}
