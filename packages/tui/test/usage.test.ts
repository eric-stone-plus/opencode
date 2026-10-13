import { describe, expect, test } from "bun:test"
import type { SessionStatsInfo } from "@opencode/client"
import {
  contextWindowRows,
  cost,
  modelLabel,
  usageActivity,
  usageModels,
  usageTotals,
  zeroCostModels,
  zeroCostNote,
} from "../src/util/usage"

const stats = (input: Partial<SessionStatsInfo> = {}): SessionStatsInfo =>
  ({
    range: { from: 0, to: 0 },
    sessions: 1,
    subagents: 0,
    prompts: 3,
    steps: 5,
    compactions: 1,
    tokens: { input: 12_000, output: 400, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.42,
    tools: { mode: "summary", totals: { calls: 7, succeeded: 6, failed: 1, unfinished: 0 } },
    activeDays: 1,
    streak: 1,
    activity: [],
    models: [],
    ...input,
  }) as SessionStatsInfo

describe("usage cost formatting", () => {
  test("keeps tiny amounts visible", () => {
    expect(cost(0)).toBe("$0.00")
    expect(cost(0.0004)).toBe("$0.0004")
    expect(cost(0.42)).toBe("$0.42")
  })
})

describe("model labels", () => {
  test("names provider, model and variant", () => {
    expect(modelLabel({ providerID: "deepseek", id: "deepseek-flash", variant: "max" })).toBe(
      "deepseek/deepseek-flash#max",
    )
    expect(modelLabel({ providerID: "deepseek", id: "deepseek-flash" })).toBe("deepseek/deepseek-flash")
  })
})

describe("usage totals", () => {
  test("lists every token class and the cost", () => {
    const rows = usageTotals(stats())
    expect(rows.map((row) => row.label)).toEqual([
      "Input tokens",
      "Output tokens",
      "Reasoning tokens",
      "Cache read tokens",
      "Cache write tokens",
      "Cost",
    ])
    expect(rows[0]?.value).toBe("12.0K")
    expect(rows[5]?.value).toBe("$0.42")
  })

  test("keeps zero classes visible so the shape does not shift", () => {
    const rows = usageTotals(stats())
    expect(rows.find((row) => row.label === "Cache write tokens")?.value).toBe("0")
    expect(rows.find((row) => row.label === "Reasoning tokens")?.value).toBe("0")
  })
})

describe("usage activity", () => {
  test("counts prompts, steps, tools and scope", () => {
    const rows = usageActivity(stats({ subagents: 2, sessions: 1 }))
    expect(rows.find((row) => row.label === "Prompts")?.value).toBe("3")
    expect(rows.find((row) => row.label === "Steps")?.value).toBe("5")
    expect(rows.find((row) => row.label === "Tool calls")?.value).toBe("7 · 1 failed")
    expect(rows.find((row) => row.label === "Scope")?.value).toBe("1 session · 2 subagents")
    // The compaction count lives in the Context window section, scoped to this session
    // rather than to `stats.compactions` (which sums the subagent tree).
    expect(rows.find((row) => row.label === "Compactions")).toBeUndefined()
  })

  test("omits tools and scope when absent", () => {
    const rows = usageActivity(
      stats({
        compactions: 0,
        tools: { mode: "summary", totals: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 } },
      }),
    )
    expect(rows.map((row) => row.label)).toEqual(["Prompts", "Steps"])
  })
})

describe("context window section", () => {
  const usage = { tokens: 25_800, limit: 1_000_000, percent: 3 }

  test("reads the window, then the session's own compaction count", () => {
    expect(contextWindowRows(usage, 12)).toEqual([
      { label: "Context tokens", value: "25.8K" },
      { label: "Context window", value: "1.0M" },
      { label: "Context used", value: "[░░░░░░░░░░] 3%" },
      { label: "Compactions", value: "12" },
    ])
  })

  test("shows the count as 0 instead of hiding it — the row is the indicator", () => {
    const rows = contextWindowRows(usage, 0)
    expect(rows.find((row) => row.label === "Compactions")?.value).toBe("0")
  })

  test("keeps the count when the window has no reading of its own", () => {
    expect(contextWindowRows(undefined, 3)).toEqual([{ label: "Compactions", value: "3" }])
  })

  test("names an unknown window size instead of a blank", () => {
    expect(contextWindowRows({ tokens: 900, percent: 40 }, 0)).toEqual([
      { label: "Context tokens", value: "900" },
      { label: "Context window", value: "window size unknown for this model" },
      { label: "Context used", value: "[████░░░░░░] 40%" },
      { label: "Compactions", value: "0" },
    ])
  })

  test("renders nothing before either input arrives", () => {
    expect(contextWindowRows(undefined, undefined)).toEqual([])
  })
})

describe("per-model usage", () => {
  test("ranks by cost, labels variants, and keeps steps", () => {
    const rows = usageModels(
      stats({
        models: [
          {
            model: { id: "mimo-v2.6-pro", providerID: "xiaomi-token-plan-cn", variant: "high" },
            steps: 2,
            compactions: 0,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.1,
          },
          {
            model: { id: "deepseek-v4-pro", providerID: "deepseek" },
            steps: 4,
            compactions: 1,
            tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 0, write: 0 } },
            cost: 0,
          },
        ],
      }),
    )
    expect(rows.map((row) => row.label)).toEqual([
      "xiaomi-token-plan-cn/mimo-v2.6-pro#high",
      "deepseek/deepseek-v4-pro",
    ])
    expect(rows[0]?.value).toBe("$0.10 · 2 steps · 15 tokens")
    expect(rows[1]?.value).toBe("$0.00 · 4 steps · 33 tokens")
  })

  test("flags zero-cost models that consumed tokens", () => {
    const flagged = zeroCostModels(
      stats({
        models: [
          {
            model: { id: "mimo-v2.6-pro", providerID: "xiaomi-token-plan-cn" },
            steps: 4,
            compactions: 0,
            tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          },
          {
            model: { id: "free", providerID: "p" },
            steps: 1,
            compactions: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          },
        ],
      }),
    )
    expect(flagged.map((entry) => modelLabel(entry.model))).toEqual(["xiaomi-token-plan-cn/mimo-v2.6-pro"])
  })

  test("explains zero-cost models, and stays silent when every model has a price", () => {
    const value = stats({
      models: [
        {
          model: { id: "mimo-v2.6-pro", providerID: "xiaomi-token-plan-cn" },
          steps: 4,
          compactions: 0,
          tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
      ],
    })
    expect(zeroCostNote(value)).toBe(
      "Subscription plans have no per-token prices, so xiaomi-token-plan-cn/mimo-v2.6-pro record $0 — not a measurement of what was actually billed.",
    )
    expect(zeroCostNote(stats())).toBeUndefined()
  })
})
