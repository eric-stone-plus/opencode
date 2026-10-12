import { describe, expect, test } from "bun:test"
import { topVariant } from "./variant.js"

describe("topVariant", () => {
  test("picks the highest ranked effort of a known ladder", () => {
    expect(topVariant(["low", "high", "max"])).toBe("max")
    expect(topVariant(["max", "high", "low"])).toBe("max")
    expect(topVariant(["none", "thinking"])).toBe("thinking")
    expect(topVariant(["minimal", "low", "medium", "high"])).toBe("high")
    expect(topVariant(["off", "minimal"])).toBe("minimal")
  })

  test("falls back to the ladder's own order when any name is unknown", () => {
    expect(topVariant(["quick", "deep"])).toBe("deep")
    expect(topVariant(["low", "custom-ish"])).toBe("custom-ish")
  })

  test("an empty ladder has no top", () => {
    expect(topVariant([])).toBeUndefined()
  })
})
