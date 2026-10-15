// Theme contrast ratchet (borrow item C15). The default theme is the fork's daily driver, and nothing
// measured whether its text still reads on the surface it is painted on: a palette edit can drop a
// label below the WCAG body-text ratio (4.5:1, or 3:1 for large and non-text content) with no test
// noticing. This gate makes the pair ratios visible and forbids new regressions.
//
// Usage:
//   bun run theme-contrast            # compare against script/theme-contrast.baseline.json
//   bun run theme-contrast --update   # ratchet the baseline to the current counts
//
// Scope: the default v2 theme (packages/tui/src/assets/v2/opencode.json), light and dark. The bundled
// v1 palettes are upstream files with deliberate low-contrast choices of their own; ratcheting them
// would mostly fire on upstream theme edits, which are not this fork's to fix.
//
// Measurement: every opaque foreground token (text.*, border.*, scrollbar.*, syntax.*, markdown.*,
// diff.text.*, diff.lineNumber.text) is paired with the background at the same role path when that
// background is opaque, and with background.base otherwise. Transparent tokens inherit whatever
// surface they sit on, so they are skipped. Counts below 4.5:1 and below 3:1 are ratcheted — the gate
// only forbids new regressions, because the default theme already has pairs below both ratios.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveThemeDocument } from "../packages/theme/src/tui/index"
import { getOpenCodeTheme, parseTheme } from "../packages/tui/src/theme/index"

export const BASELINE_PATH = "script/theme-contrast.baseline.json"

export const MODES = ["light", "dark"] as const
export type Mode = (typeof MODES)[number]

// Foreground groups. `diff.background.*` and the `categorical`/`hue` ramps are surfaces and palettes
// rather than content, so they are not paired.
const FOREGROUND = /^(text\.|border\.|scrollbar\.|syntax\.|markdown\.|diff\.text\.|diff\.lineNumber\.text)/
const ROLE_PREFIX = /^(text|border|scrollbar|syntax|markdown|diff)\./

export type Color = { r: number; g: number; b: number; a: number }
export type Pair = { path: string; reference: string; ratio: number }
export type Counts = { below45: number; below30: number }
export type Baseline = Record<Mode, Counts>

export function isColor(value: unknown): value is Color {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<Color>
  return (
    typeof candidate.r === "number" &&
    typeof candidate.g === "number" &&
    typeof candidate.b === "number" &&
    typeof candidate.a === "number"
  )
}

// WCAG relative luminance and contrast ratio. Input channels are 0..1 floats, which is what the
// resolved theme carries.
export function contrastRatio(a: Color, b: Color): number {
  const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const luminance = (color: Color) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

function lookup(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  }, root)
}

export function collectPairs(resolved: unknown): Pair[] {
  const base = lookup(resolved, "background.base")
  if (!isColor(base) || base.a < 1) throw new Error("theme: background.base is missing or not opaque")
  const pairs: Pair[] = []
  const walk = (value: unknown, prefix: string) => {
    if (isColor(value)) {
      if (!FOREGROUND.test(prefix) || value.a < 1) return
      const rolePath = prefix.replace(ROLE_PREFIX, "background.")
      const candidate = lookup(resolved, rolePath)
      const reference = isColor(candidate) && candidate.a >= 1 ? candidate : base
      pairs.push({
        path: prefix,
        reference: reference === base ? "background.base" : rolePath,
        ratio: contrastRatio(value, reference),
      })
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) walk(child, prefix === "" ? key : `${prefix}.${key}`)
  }
  walk(resolved, "")
  return pairs
}

export function countPairs(pairs: readonly Pair[]): Counts {
  return {
    below45: pairs.filter((pair) => pair.ratio < 4.5).length,
    below30: pairs.filter((pair) => pair.ratio < 3).length,
  }
}

export function collect(): Baseline {
  const document = parseTheme(getOpenCodeTheme(), "opencode")
  const baseline = {} as Baseline
  for (const mode of MODES) {
    const resolved = resolveThemeDocument(document, mode)
    baseline[mode] = countPairs(collectPairs(resolved))
  }
  return baseline
}

export async function readBaseline(directory: string): Promise<Baseline> {
  const file = path.join(directory, BASELINE_PATH)
  if (!(await Bun.file(file).exists())) {
    return { light: { below45: 0, below30: 0 }, dark: { below45: 0, below30: 0 } }
  }
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${BASELINE_PATH}: expected a JSON object`)
  const baseline = {} as Baseline
  for (const mode of MODES) {
    const counts = (parsed as Record<string, unknown>)[mode]
    if (typeof counts !== "object" || counts === null) throw new Error(`${BASELINE_PATH}: missing ${mode}`)
    const below45 = (counts as Record<string, unknown>).below45
    const below30 = (counts as Record<string, unknown>).below30
    if (typeof below45 !== "number" || typeof below30 !== "number") {
      throw new Error(`${BASELINE_PATH}: ${mode} needs numeric below45 and below30`)
    }
    baseline[mode] = { below45, below30 }
  }
  return baseline
}

export async function writeBaseline(directory: string, baseline: Baseline): Promise<void> {
  const file = path.join(directory, BASELINE_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8")
}

export function ratchetProblems(current: Baseline, baseline: Baseline): string[] {
  const problems: string[] = []
  for (const mode of MODES) {
    for (const key of ["below45", "below30"] as const) {
      const now = current[mode][key]
      const allowed = baseline[mode][key]
      if (now > allowed) problems.push(`${mode} ${key}: ${allowed} -> ${now}`)
    }
  }
  return problems
}

if (import.meta.main) {
  const directory = process.cwd()
  const current = collect()
  const pairs = collectPairs(resolveThemeDocument(parseTheme(getOpenCodeTheme(), "opencode"), "dark"))
  if (process.argv.includes("--update")) {
    await writeBaseline(directory, current)
    console.log("theme contrast baseline updated:")
    for (const mode of MODES) console.log(`  ${mode}: below45=${current[mode].below45} below30=${current[mode].below30}`)
  }
  const baseline = await readBaseline(directory)
  for (const mode of MODES) {
    const before = baseline[mode]
    const now = current[mode]
    const marker = now.below45 > before.below45 || now.below30 > before.below30 ? "GREW" : "ok"
    console.log(
      `  ${mode}: below45 ${before.below45} -> ${now.below45}, below30 ${before.below30} -> ${now.below30} (${marker})`,
    )
  }
  console.log("  worst dark pairs:")
  for (const pair of pairs.sort((left, right) => left.ratio - right.ratio).slice(0, 5)) {
    console.log(`    ${pair.ratio.toFixed(2)} ${pair.path} on ${pair.reference}`)
  }
  const problems = ratchetProblems(current, baseline)
  if (problems.length > 0) {
    console.error("theme contrast ratchet failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      "\nRaise the token's contrast, or acknowledge the regression deliberately:\n" +
        `  bun run theme-contrast --update   # then commit ${BASELINE_PATH} with the change that caused it`,
    )
    process.exit(1)
  }
  console.log("theme contrast: ok")
}
