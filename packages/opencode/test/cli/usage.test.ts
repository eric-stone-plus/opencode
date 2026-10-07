import { describe, expect, test } from "bun:test"
import type { PricingBackfill } from "@opencode-ai/core/pricing/backfill"
import { renderBackfill } from "@/cli/cmd/usage"

const summary = (over: Partial<PricingBackfill.Summary> = {}): PricingBackfill.Summary => ({
  models: [],
  unpriced: [],
  messages: 0,
  parts: 0,
  sessions: 0,
  delta: 0,
  failed: [],
  ...over,
})

describe("renderBackfill", () => {
  test("dry run states that no rows are written and names the offline flag", () => {
    const lines = renderBackfill({ summary: summary(), apply: false, path: "/tmp/db.sqlite" })
    const text = lines.join("\n")
    expect(text).toContain("dry run")
    expect(text).toContain("no database rows written")
    expect(text).toContain("OPENCODE_DISABLE_MODELS_FETCH=1")
    expect(text).toContain("/tmp/db.sqlite")
  })

  test("apply prints actual counts including zero", () => {
    const lines = renderBackfill({ summary: summary(), apply: true, path: "/tmp/db.sqlite" })
    const text = lines.join("\n")
    expect(text).toContain("messages=0 parts=0 sessions=0")
    expect(text).toContain("/tmp/db.sqlite")
    expect(text).not.toContain("dry run")
  })

  test("estimates are labeled on the per-model table and the total", () => {
    const lines = renderBackfill({
      summary: summary({
        models: [
          {
            providerID: "demo-pricing",
            modelID: "demo-model",
            match: { cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 }, source: "cross-provider" },
            messages: 1,
            parts: 2,
            sessions: 1,
            delta: 0.0005,
          },
        ],
        messages: 1,
        parts: 2,
        sessions: 1,
        delta: 0.0005,
      }),
      apply: true,
      path: "/tmp/db.sqlite",
    })
    const label = "estimated at registry list prices (flat-rate plans are not billed per token)"
    const total = lines.find((line) => line.startsWith("total:"))
    expect(total).toContain(label)
    expect(lines.find((line) => line.includes("demo-pricing/demo-model"))).toBeDefined()
    // The per-model table header carries the same estimate label.
    expect(lines.slice(0, lines.length - 2).join("\n")).toContain(label)
    // Numbers pass through unchanged.
    expect(lines.some((line) => line.includes("messages=1 parts=2 sessions=1 delta=$0.0005"))).toBe(true)
    expect(lines.some((line) => line.includes("input=$2 output=$6 cache_read=$0.25 cache_write=$2.5"))).toBe(true)
  })

  test("failed sessions are listed", () => {
    const lines = renderBackfill({ summary: summary({ failed: ["ses_123", "ses_456"] }), apply: true, path: "/tmp/db.sqlite" })
    const text = lines.join("\n")
    expect(text).toContain("ses_123")
    expect(text).toContain("ses_456")
  })
})
