import { describe, expect, test } from "bun:test"
import type { SessionStatsInfo } from "@opencode/client"
import { cost, modelLabel, usageModels, usageTotals, zeroCostModels } from "../src/util/usage"

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

describe("usage totals", () => {
  test("names cost, tokens and activity", () => {
    const rows = usageTotals(stats())
    expect(rows[0]).toEqual({ label: "Cost", value: "$0.42" })
    expect(rows[1]?.value).toBe("12.0K in · 400 out")
    expect(rows[2]?.value).toBe("3 prompts · 5 steps · 1 compaction")
    expect(rows.find((row) => row.label === "Tools")?.value).toBe("7 calls · 1 failed")
  })

  test("omits the scope row for a lone session and cache classes at zero", () => {
    const rows = usageTotals(stats())
    expect(rows.some((row) => row.label === "Scope")).toBe(false)
    expect(rows.some((row) => row.value.includes("cache"))).toBe(false)
  })

  test("shows the scope row once subagents are counted", () => {
    const rows = usageTotals(stats({ subagents: 2 }))
    expect(rows.find((row) => row.label === "Scope")?.value).toBe("1 session · 2 subagents")
  })

  test("adds cache classes when present", () => {
    const rows = usageTotals(
      stats({ tokens: { input: 1_000, output: 10, reasoning: 5, cache: { read: 2_000, write: 300 } } }),
    )
    expect(rows[1]?.value).toBe("1.0K in · 10 out · 5 reasoning · 2.0K cache read · 300 cache write")
  })
})

describe("per-model usage", () => {
  test("ranks by cost and labels provider and model", () => {
    const rows = usageModels(
      stats({
        models: [
          {
            model: { id: "deepseek-flash", providerID: "deepseek" },
            steps: 2,
            compactions: 0,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.1,
          },
          {
            model: { id: "glm-5.3", providerID: "zhipuai-coding-plan" },
            steps: 4,
            compactions: 1,
            tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 0, write: 0 } },
            cost: 0,
          },
        ],
      }),
    )
    expect(rows.map((row) => row.label)).toEqual(["deepseek/deepseek-flash", "zhipuai-coding-plan/glm-5.3"])
    expect(rows[0]?.detail).toBe("2 steps · 15 tokens")
    expect(rows[1]?.detail).toBe("4 steps · 33 tokens · 1 compaction")
  })

  test("flags zero-cost models that consumed tokens", () => {
    const flagged = zeroCostModels(
      stats({
        models: [
          {
            model: { id: "glm-5.3", providerID: "zhipuai-coding-plan" },
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
    expect(flagged.map((entry) => modelLabel(entry.model))).toEqual(["zhipuai-coding-plan/glm-5.3"])
  })
})
