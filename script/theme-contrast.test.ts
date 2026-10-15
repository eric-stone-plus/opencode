import { describe, expect, test } from "bun:test"
import path from "node:path"
import { collect, collectPairs, contrastRatio, countPairs, ratchetProblems, readBaseline } from "./theme-contrast"

const color = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a })

describe("theme contrast", () => {
  test("computes the WCAG ratio at both extremes", () => {
    expect(contrastRatio(color(0, 0, 0), color(1, 1, 1))).toBeCloseTo(21, 5)
    expect(contrastRatio(color(0.5, 0.5, 0.5), color(0.5, 0.5, 0.5))).toBeCloseTo(1, 5)
  })

  test("pairs a foreground with its role background and falls back to background.base", () => {
    const pairs = collectPairs({
      background: { base: color(0, 0, 0), action: { primary: { base: color(1, 1, 1) } } },
      text: {
        base: color(1, 1, 1),
        muted: color(0.2, 0.2, 0.2),
        action: { primary: { base: color(0, 0, 0) } },
      },
    })

    expect(pairs.map((pair) => `${pair.path} on ${pair.reference}`)).toEqual([
      "text.base on background.base",
      "text.muted on background.base",
      "text.action.primary.base on background.action.primary.base",
    ])
  })

  test("skips transparent tokens and transparent role backgrounds", () => {
    const pairs = collectPairs({
      background: { base: color(0, 0, 0), action: { primary: { base: color(1, 1, 1, 0) } } },
      text: { base: color(1, 1, 1), invisible: color(1, 1, 1, 0), action: { primary: { base: color(0, 0, 0) } } },
    })

    expect(pairs.map((pair) => pair.path)).toEqual(["text.base", "text.action.primary.base"])
    expect(pairs.map((pair) => pair.reference)).toEqual(["background.base", "background.base"])
  })

  test("leaves palette and surface groups out of the pairs", () => {
    const pairs = collectPairs({
      background: { base: color(0, 0, 0), diff: { background: { added: color(0.1, 0.1, 0.1) } } },
      hue: { gray: { 100: color(1, 1, 1) } },
      categorical: { 0: { 900: color(1, 1, 1) } },
      diff: { background: { context: color(0.2, 0.2, 0.2) } },
    })

    expect(pairs).toEqual([])
  })

  test("counts the ratios below each threshold", () => {
    expect(
      countPairs([
        { path: "a", reference: "b", ratio: 4.4 },
        { path: "c", reference: "d", ratio: 2.9 },
        { path: "e", reference: "f", ratio: 7 },
      ]),
    ).toEqual({ below45: 2, below30: 1 })
  })

  test("ratchets counts per mode and threshold", () => {
    const baseline = { light: { below45: 44, below30: 9 }, dark: { below45: 4, below30: 2 } }
    expect(ratchetProblems(baseline, baseline)).toEqual([])
    expect(
      ratchetProblems({ light: { below45: 45, below30: 9 }, dark: { below45: 4, below30: 2 } }, baseline),
    ).toEqual(["light below45: 44 -> 45"])
  })

  test("the default theme is at or below its baseline", async () => {
    const current = collect()
    const baseline = await readBaseline(path.resolve(import.meta.dirname, ".."))
    expect(ratchetProblems(current, baseline)).toEqual([])
    // The default theme starts with known low-contrast pairs; the gate forbids new ones, not these.
    expect(current.light.below45).toBeGreaterThan(0)
  })
})
