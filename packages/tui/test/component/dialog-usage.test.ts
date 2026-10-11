import { describe, expect, test } from "bun:test"
import {
  usageSection,
  USAGE_ESTIMATE_NOTE,
  USAGE_FALLBACK_NOTE,
  sessionTotals,
  selectUsageTotals,
} from "../../src/component/dialog-usage"

const totals = {
  input: 1200,
  output: 340,
  reasoning: 0,
  cacheRead: 50,
  cacheWrite: 10,
  cost: 0.0123,
  sum: 1600.0123,
  source: "session" as const,
}

describe("dialog usage section", () => {
  test("estimates cost from registry list prices when usage is recorded", () => {
    const section = usageSection({
      loadedMessages: 5,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 4,
      turns: 3,
      totals,
    })
    expect(section.rows).toContainEqual({ label: "Cost", value: "$0.01" })
    expect(section.footnotes).toEqual([
      "Source: Totals from session aggregates.",
      USAGE_ESTIMATE_NOTE,
    ])
  })

  test("keeps the under-count note when totals come from loaded messages", () => {
    const section = usageSection({
      loadedMessages: 5,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 0,
      turns: 0,
      totals: { ...totals, source: "messages" },
    })
    expect(section.footnotes).toEqual([
      "Source: Totals aggregated from 5 loaded messages.",
      USAGE_FALLBACK_NOTE,
      USAGE_ESTIMATE_NOTE,
    ])
  })

  test("reports backfilled spend without loaded messages", () => {
    const section = usageSection({
      loadedMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      turns: 0,
      totals,
    })
    expect(section.rows).toContainEqual({ label: "Cost", value: "$0.01" })
    expect(section.footnotes).toEqual([
      "Source: Totals from session aggregates.",
      USAGE_ESTIMATE_NOTE,
    ])
  })

  test("adds no pricing note when no model calls happened", () => {
    const section = usageSection({
      loadedMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      turns: 0,
      totals: { ...totals, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sum: 0 },
    })
    expect(section.rows).toEqual([{ label: "Usage", value: "No model calls yet in this session." }])
    expect(section.footnotes).toEqual([])
  })

  test("adds no pricing note when nothing is recorded", () => {
    const section = usageSection({
      loadedMessages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      turns: 0,
      totals: { ...totals, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sum: 0 },
    })
    expect(section.rows).toEqual([
      { label: "Usage", value: "None recorded, but tracking is incomplete and may under-count." },
    ])
    expect(section.footnotes).toEqual([])
  })

  test("names the capped window when the fallback supplies totals", () => {
    const section = usageSection({
      loadedMessages: 100,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 0,
      turns: 0,
      totals: { ...totals, source: "messages" },
    })
    expect(section.footnotes).toContain(USAGE_FALLBACK_NOTE)
    expect(USAGE_FALLBACK_NOTE).toMatch(/at most 100/)
    expect(USAGE_FALLBACK_NOTE).toMatch(/compact/i)
  })
})

describe("dialog usage totals selection", () => {
  const sessionInfo = {
    cost: 1.55,
    tokens: {
      input: 1000,
      output: 200,
      reasoning: 50,
      cache: { read: 4000, write: 10 },
    },
  }
  // Window shaped like the loaded tail after a compaction: only recent spend.
  const derivedWindow = {
    input: 300,
    output: 60,
    reasoning: 10,
    cacheRead: 800,
    cacheWrite: 0,
    cost: 0.45,
    sum: 1220.45,
    source: "messages" as const,
  }

  test("keeps lifetime session aggregates over a smaller loaded window", () => {
    const selected = selectUsageTotals({ stored: sessionTotals(sessionInfo), derived: derivedWindow })
    expect(selected.source).toBe("session")
    expect(selected.cost).toBeCloseTo(1.55)
    expect(selected.input).toBe(1000)
  })

  test("uses session cost even when the session payload has no tokens", () => {
    const selected = selectUsageTotals({
      stored: sessionTotals({ cost: 1.55 }),
      derived: derivedWindow,
    })
    expect(selected.source).toBe("session")
    expect(selected.cost).toBeCloseTo(1.55)
  })

  test("falls back to loaded messages when session aggregates are zero", () => {
    const selected = selectUsageTotals({
      stored: sessionTotals({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      derived: derivedWindow,
    })
    expect(selected.source).toBe("messages")
    expect(selected.cost).toBeCloseTo(0.45)
  })

  test("falls back to loaded messages when the session payload is absent", () => {
    const selected = selectUsageTotals({ stored: sessionTotals(undefined), derived: derivedWindow })
    expect(selected.source).toBe("messages")
    expect(selected.cost).toBeCloseTo(0.45)
  })
})
