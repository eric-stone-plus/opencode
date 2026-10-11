import { describe, expect, test } from "bun:test"
import { topVariant } from "../src/variant"

describe("topVariant", () => {
  test("known effort names rank semantically, not by list order", () => {
    expect(topVariant(["max", "high"])).toBe("max")
    expect(topVariant(["high", "max"])).toBe("max")
    expect(topVariant(["low", "medium", "high"])).toBe("high")
    expect(topVariant(["low", "high", "max"])).toBe("max")
    expect(topVariant(["high", "xhigh"])).toBe("xhigh")
  })

  test("toggle ladders: the enabled tier beats none/off", () => {
    expect(topVariant(["none", "high"])).toBe("high")
    expect(topVariant(["high", "none"])).toBe("high")
    expect(topVariant(["off", "low"])).toBe("low")
  })

  test("unknown names fall back to the ladder's own order (last entry)", () => {
    expect(topVariant(["low", "weird"])).toBe("weird")
    expect(topVariant(["weird", "low"])).toBe("low")
    expect(topVariant(["weird1", "weird2"])).toBe("weird2")
  })

  test("degenerate ladders", () => {
    expect(topVariant([])).toBeUndefined()
    expect(topVariant(["high"])).toBe("high")
    expect(topVariant(["high", "low", "high"])).toBe("high")
    expect(topVariant(["none", "off"])).toBe("none")
  })
})
