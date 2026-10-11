import { describe, expect, test } from "bun:test"
import {
  usageSection,
  USAGE_ESTIMATE_NOTE,
  USAGE_FALLBACK_NOTE,
  USAGE_COMPACTION_FALLBACK_NOTE,
  USAGE_MODEL_NOTE,
  sessionTotals,
  selectUsageTotals,
  selectCompactionTotal,
  modelUsageRows,
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
    expect(section.footnotes).toEqual(["Source: Totals from session aggregates.", USAGE_ESTIMATE_NOTE])
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
    expect(section.footnotes).toEqual(["Source: Totals from session aggregates.", USAGE_ESTIMATE_NOTE])
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

  test("reports the lifetime compaction count without a fallback note", () => {
    const section = usageSection({
      loadedMessages: 5,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 0,
      turns: 3,
      totals,
      compactions: { count: 37, source: "session" },
    })
    expect(section.rows).toContainEqual({ label: "Compactions", value: "37" })
    expect(section.footnotes).not.toContain(USAGE_COMPACTION_FALLBACK_NOTE)
  })

  test("flags a windowed compaction count as possibly under-counted", () => {
    const section = usageSection({
      loadedMessages: 100,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 0,
      turns: 3,
      totals,
      compactions: { count: 2, source: "messages" },
    })
    expect(section.rows).toContainEqual({ label: "Compactions", value: "2" })
    expect(section.footnotes).toContain(USAGE_COMPACTION_FALLBACK_NOTE)
    expect(USAGE_COMPACTION_FALLBACK_NOTE).toMatch(/at most 100/)
  })
})

describe("dialog usage compaction selection", () => {
  test("prefers the lifetime aggregate over the loaded window", () => {
    expect(selectCompactionTotal({ stored: 42, derived: 3 })).toEqual({ count: 42, source: "session" })
  })

  test("takes a zero aggregate at face value when nothing is loaded", () => {
    expect(selectCompactionTotal({ stored: 0, derived: 0 })).toEqual({ count: 0, source: "session" })
  })

  test("falls back to loaded markers when a legacy row has no aggregate", () => {
    expect(selectCompactionTotal({ stored: 0, derived: 4 })).toEqual({ count: 4, source: "messages" })
  })

  test("falls back to loaded markers when the session payload predates the column", () => {
    expect(selectCompactionTotal({ stored: undefined, derived: 4 })).toEqual({ count: 4, source: "messages" })
  })
})

describe("dialog usage by-model breakdown", () => {
  const assistant = (id: string, providerID: string, modelID: string, cost: number) =>
    ({
      id,
      role: "assistant",
      providerID,
      modelID,
      cost,
      time: { created: 0, completed: 1 },
      tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as unknown as Parameters<typeof modelUsageRows>[0]["messages"][number]

  const stepFinish = (input: number, output: number) =>
    ({
      type: "step-finish",
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as unknown as Parameters<typeof modelUsageRows>[0]["parts"][string][number]

  test("is empty for a single-model session, where the session row is exact", () => {
    const rows = modelUsageRows({
      messages: [assistant("m1", "deepseek", "flash", 1)],
      parts: { m1: [stepFinish(10, 5)] },
    })
    expect(rows).toEqual([])
  })

  test("sums every step-finish receipt, not the last-step message totals", () => {
    const rows = modelUsageRows({
      messages: [assistant("m1", "deepseek", "flash", 2), assistant("m2", "xiaomi", "mimo", 0.5)],
      // Two steps on the expensive model, one on the cheap one.
      parts: { m1: [stepFinish(100, 10), stepFinish(200, 20)], m2: [stepFinish(5, 1)] },
    })
    // 330 tokens for flash (not the 999+999 message.tokens last-step figure).
    expect(rows[0]).toEqual({ label: "deepseek/flash", value: "$2.00 · 330 tokens" })
    expect(rows[1]).toEqual({ label: "xiaomi/mimo", value: "$0.50 · 6 tokens" })
  })

  test("orders by cost, most expensive first", () => {
    const rows = modelUsageRows({
      messages: [assistant("m1", "cheap", "small", 0.1), assistant("m2", "pricey", "big", 9)],
      parts: { m1: [stepFinish(1, 1)], m2: [stepFinish(1, 1)] },
    })
    expect(rows.map((row) => row.label)).toEqual(["pricey/big", "cheap/small"])
  })

  test("falls back to message totals when no receipts are loaded", () => {
    const rows = modelUsageRows({
      messages: [assistant("m1", "a", "one", 1), assistant("m2", "b", "two", 2)],
      parts: {},
    })
    expect(rows).toEqual([
      { label: "b/two", value: "$2.00 · 1,998 tokens" },
      { label: "a/one", value: "$1.00 · 1,998 tokens" },
    ])
  })

  test("states that by-model totals are window-limited", () => {
    expect(USAGE_MODEL_NOTE).toMatch(/loaded message window/)
    expect(USAGE_MODEL_NOTE).toMatch(/compacted/)
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
