import { describe, expect, test } from "bun:test"
import { usageSection, USAGE_ESTIMATE_NOTE } from "../../src/component/dialog-usage"

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
      "Note: usage is incomplete and may under-count.",
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
})
