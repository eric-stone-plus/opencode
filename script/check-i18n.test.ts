import path from "node:path"
import { describe, expect, test } from "bun:test"
import { collect, isPluralVariant, orphanKeys, placeholderDrift, placeholders, ratchetProblems } from "./check-i18n"

describe("i18n alignment", () => {
  test("extracts interpolation tokens in sorted order", () => {
    expect(placeholders("{{count}} of {{total}}")).toEqual(["count", "total"])
    expect(placeholders("no tokens")).toEqual([])
  })

  test("treats plural categories of a source key as aligned, not stale", () => {
    const en = { "x.count.other": "{{count}} items", "x.plain": "Plain" }
    expect(isPluralVariant(en, "x.count.one")).toBe(true)
    expect(isPluralVariant(en, "x.count.many")).toBe(true)
    expect(isPluralVariant(en, "x.missing.one")).toBe(false)
    expect(isPluralVariant(en, "x.plain.one")).toBe(true)
    expect(orphanKeys(en, { "x.count.few": "f", "x.renamed": "r", "x.plain": "p" })).toEqual(["x.renamed"])
  })

  test("flags a dropped, renamed, or invented placeholder", () => {
    const en = { "x.a": "{{count}} items", "x.b": "Hello", "x.c.other": "{{count}} items" }
    expect(placeholderDrift(en, { "x.a": "{{count}} Elemente", "x.b": "Hallo", "x.c.many": "{{count}} viele" })).toEqual(
      [],
    )
    expect(placeholderDrift(en, { "x.a": "Elemente" })).toEqual(["x.a: [count] -> []"])
    expect(placeholderDrift(en, { "x.a": "{{n}} Elemente" })).toEqual(["x.a: [count] -> [n]"])
    expect(placeholderDrift(en, { "x.b": "{{name}} Hallo" })).toEqual(["x.b: [] -> [name]"])
  })

  test("ratchets orphan counts against the baseline", () => {
    expect(ratchetProblems({ "a.ts": 2, "b.ts": 0 }, { "a.ts": 2 })).toEqual([])
    expect(ratchetProblems({ "a.ts": 3 }, { "a.ts": 2 })).toEqual(["a.ts: orphan keys grew 2 -> 3"])
    expect(ratchetProblems({ "c.ts": 1 }, {})).toEqual(["c.ts: orphan keys grew 0 -> 1"])
  })

  test("the live dictionaries are aligned", async () => {
    const report = await collect(path.resolve(import.meta.dirname, ".."))
    expect(report.strict).toEqual([])
    expect(report.coverage.length).toBeGreaterThan(100)
  })
})
