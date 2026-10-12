import { describe, expect, test } from "bun:test"
import { purgeSummary } from "../src/component/dialog-purge-keys"

const result = (input: { credentials?: number; swept?: number; remaining?: number }) => ({
  dryRun: false,
  credentials: Array.from({ length: input.credentials ?? 0 }, (_, index) => ({ id: `crd_${index}` })),
  secrets: { distinct: 1, shared: 0, short: 0 },
  swept: Array.from({ length: input.swept ?? 0 }, (_, index) => ({ location: `l${index}` })),
  remaining: Array.from({ length: input.remaining ?? 0 }, (_, index) => ({ location: `r${index}` })),
}) as unknown as Parameters<typeof purgeSummary>[0]

describe("purgeSummary", () => {
  test("reports counts without values", () => {
    expect(purgeSummary(result({ credentials: 2, swept: 3 }))).toBe("Removed 2 credentials; swept 3 locations")
  })

  test("singularizes", () => {
    expect(purgeSummary(result({ credentials: 1, swept: 1 }))).toBe("Removed 1 credential; swept 1 location")
  })

  test("names leftovers that still need attention", () => {
    expect(purgeSummary(result({ credentials: 1, swept: 2, remaining: 1 }))).toBe(
      "Removed 1 credential; swept 2 locations, 1 need attention",
    )
  })
})
