// i18n alignment gate (borrow item C36 — the gate, not the translation volume). The dictionaries
// under packages/ui/src/i18n and packages/app/src/runtime/i18n carry one file per locale, and
// nothing enforced that they stay aligned with the English source: a renamed key leaves a stale
// translation behind, and a translation that drops a `{{placeholder}}` silently loses data at
// runtime. This gate makes both visible.
//
// Usage:
//   bun run check-i18n            # compare against script/i18n.baseline.json
//   bun run check-i18n --update   # ratchet the baseline to the current orphan counts
//
// Placeholder drift is strict: the trees are clean today, and a dropped or renamed interpolation
// token is a data-loss bug in any locale, so it fails outright.
//
// Orphan keys (a locale key with no English counterpart) are ratcheted, the same shape as
// script/debt-ratchet.ts: upstream renames a key without cleaning every locale, so an upstream
// merge that adds orphans fails this gate until `--update` records them, and the printed delta is
// the review artifact.
//
// Coverage (keys a locale is missing) is reported, never gated: translations legitimately lag the
// English source, and gating that would turn every upstream string addition into a red build.
// A byte-stability contract on the dictionaries themselves is deliberately absent for the same
// reason — these are upstream-owned files, and a hash pin would block the merge-only sync.

import { readdir, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const BASELINE_PATH = "script/i18n.baseline.json"

export const ROOTS = ["packages/ui/src/i18n", "packages/app/src/runtime/i18n"] as const

const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"])
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/
const PLACEHOLDER = /{{\s*([^}]+?)\s*}}/g

export type Dict = Record<string, string>
export type Counts = Record<string, number>
export type Coverage = { file: string; missing: number }
export type Report = { strict: string[]; orphans: Counts; coverage: Coverage[] }

export function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "").sort()
}

// A locale key that is not in the English source is stale unless it is a plural category of a
// source key (`<base>` or `<base>.other`), which is how locales encode categories English does not
// use — Arabic's `zero`/`two`, Slavic `few`/`many`.
export function isPluralVariant(en: Dict, key: string): boolean {
  const match = /^(.*)\.([^.]+)$/.exec(key)
  if (!match || !PLURAL_CATEGORIES.has(match[2] ?? "")) return false
  const base = match[1] ?? ""
  return Object.hasOwn(en, base) || Object.hasOwn(en, `${base}.other`)
}

export function orphanKeys(en: Dict, dict: Dict): string[] {
  return Object.keys(dict).filter((key) => !Object.hasOwn(en, key) && !isPluralVariant(en, key))
}

// Compares the interpolation tokens of every translated value against the English reference for the
// same key, or against the plural base when the locale adds a category English does not have.
export function placeholderDrift(en: Dict, dict: Dict): string[] {
  const problems: string[] = []
  for (const [key, value] of Object.entries(dict)) {
    const reference = en[key] ?? en[key.replace(PLURAL_SUFFIX, ".other")]
    if (reference === undefined) continue
    const expected = placeholders(reference).join(", ")
    const actual = placeholders(value).join(", ")
    if (expected !== actual) problems.push(`${key}: [${expected}] -> [${actual}]`)
  }
  return problems
}

async function loadDict(file: string): Promise<Dict | undefined> {
  const module = (await import(file)) as { dict?: unknown }
  if (typeof module.dict !== "object" || module.dict === null) return undefined
  return module.dict as Dict
}

export async function collect(directory: string): Promise<Report> {
  const strict: string[] = []
  const orphans: Counts = {}
  const coverage: Coverage[] = []
  for (const root of ROOTS) {
    const files = (await readdir(path.join(directory, root)))
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .sort()
    const en = await loadDict(path.resolve(directory, root, "en.ts"))
    if (en === undefined) {
      strict.push(`${root}/en.ts: the English source dictionary is missing or has no dict export`)
      continue
    }
    const enKeys = Object.keys(en)
    for (const file of files) {
      if (file === "en.ts") continue
      const relative = `${root}/${file}`
      const dict = await loadDict(path.resolve(directory, root, file))
      if (dict === undefined) continue
      const stale = orphanKeys(en, dict)
      if (stale.length > 0) orphans[relative] = stale.length
      for (const problem of placeholderDrift(en, dict)) strict.push(`${relative}: placeholder drift ${problem}`)
      coverage.push({ file: relative, missing: enKeys.filter((key) => !Object.hasOwn(dict, key)).length })
    }
  }
  return { strict, orphans, coverage }
}

export async function readBaseline(directory: string): Promise<Counts> {
  const file = path.join(directory, BASELINE_PATH)
  if (!(await Bun.file(file).exists())) return {}
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${BASELINE_PATH}: expected a JSON object`)
  const counts: Counts = {}
  for (const [file, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "number") throw new Error(`${BASELINE_PATH}: ${file} is not a number`)
    counts[file] = value
  }
  return counts
}

export async function writeBaseline(directory: string, counts: Counts): Promise<void> {
  const ordered: Counts = {}
  for (const file of Object.keys(counts).sort()) {
    const value = counts[file] ?? 0
    if (value > 0) ordered[file] = value
  }
  const file = path.join(directory, BASELINE_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`, "utf8")
}

export function ratchetProblems(current: Counts, baseline: Counts): string[] {
  const problems: string[] = []
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) problems.push(`${file}: orphan keys grew ${allowed} -> ${count}`)
  }
  return problems
}

function summarize(report: Report) {
  for (const root of ROOTS) {
    const rows = report.coverage.filter((row) => row.file.startsWith(`${root}/`))
    if (rows.length === 0) continue
    const missing = rows.reduce((total, row) => total + row.missing, 0)
    const worst = rows.reduce((worst, row) => (row.missing > worst.missing ? row : worst), rows[0]!)
    console.log(
      `  ${root}: locales=${rows.length} missing keys total=${missing} worst=${worst.file} (${worst.missing})`,
    )
  }
}

if (import.meta.main) {
  const directory = process.cwd()
  const report = await collect(directory)
  if (process.argv.includes("--update")) {
    await writeBaseline(directory, report.orphans)
    console.log("i18n baseline updated:")
    for (const [file, count] of Object.entries(report.orphans)) console.log(`  ${file}: ${count}`)
    if (Object.keys(report.orphans).length === 0) console.log("  (no orphan keys)")
  }
  const baseline = await readBaseline(directory)
  const problems = [...report.strict, ...ratchetProblems(report.orphans, baseline)]
  summarize(report)
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(report.orphans)]).values()) {
    const allowed = baseline[file] ?? 0
    const now = report.orphans[file] ?? 0
    const marker = now > allowed ? "GREW" : now < allowed ? "can shrink" : "ok"
    console.log(`  ${file}: ${allowed} -> ${now} (${marker})`)
  }
  if (problems.length > 0) {
    console.error("i18n alignment failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      "\nFix the translation, or acknowledge the new orphan keys deliberately:\n" +
        `  bun run check-i18n --update   # then commit ${BASELINE_PATH} with the change that added them`,
    )
    process.exit(1)
  }
  console.log("i18n alignment: ok")
}
