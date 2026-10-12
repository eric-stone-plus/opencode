import { describe, expect, test } from "bun:test"
import { WORKING_CONTEXT_CAP, workingContextCap, window } from "../src/util/working-context.js"

describe("working-context policy", () => {
  test("defaults to the working-context cap for advertised large windows", () => {
    expect(WORKING_CONTEXT_CAP).toBe(256_000)
    expect(window({ context: 1_000_000, input: 606_784 })).toBe(256_000)
    expect(window({ context: 1_000_000 })).toBe(256_000)
  })

  test("leaves windows below the cap alone and prefers the input limit", () => {
    expect(window({ context: 200_000 })).toBe(200_000)
    expect(window({ context: 400_000, input: 200_000 })).toBe(200_000)
    expect(window({ context: 0, input: undefined })).toBe(0)
  })

  test("a cap raises the clamp up to the model's own budget, never past it", () => {
    expect(window({ context: 1_000_000, input: 606_784 }, 606_784)).toBe(606_784)
    expect(window({ context: 1_000_000, input: 606_784 }, 900_000)).toBe(606_784)
    expect(window({ context: 1_000_000, input: 606_784 }, 100_000)).toBe(100_000)
  })

  test("accepts only safe-integer caps above the reserve", () => {
    expect(workingContextCap({ workingContextCap: 852_544 })).toBe(852_544)
    expect(workingContextCap({ workingContextCap: 256_000 })).toBe(256_000)
    expect(workingContextCap({ workingContextCap: 20_000 })).toBeUndefined()
    expect(workingContextCap({ workingContextCap: 20_001 })).toBe(20_001)
    expect(workingContextCap({ workingContextCap: true })).toBeUndefined()
    expect(workingContextCap({ workingContextCap: 1.5 })).toBeUndefined()
    expect(workingContextCap({ workingContextCap: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(workingContextCap({ workingContextCap: "500000" })).toBeUndefined()
    expect(workingContextCap({})).toBeUndefined()
    expect(workingContextCap(undefined)).toBeUndefined()
  })
})
