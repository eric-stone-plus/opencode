import { describe, expect, test } from "bun:test"
import { messageTokenUsage } from "@/cli/cmd/stats"

const step = (input: number, output: number, reasoning = 0, read = 0, write = 0) =>
  ({
    type: "step-finish",
    tokens: { input, output, reasoning, cache: { read, write } },
  }) as const

describe("messageTokenUsage", () => {
  test("sums every step-finish receipt so multi-step turns count whole", () => {
    // message.tokens would report only the last step (999) — the bug this fixes.
    expect(
      messageTokenUsage({
        parts: [step(100, 10), step(200, 20)],
        tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ).toEqual({ input: 300, output: 30, cache: { read: 0, write: 0 } })
  })

  test("folds reasoning into output, matching how it is billed", () => {
    expect(messageTokenUsage({ parts: [step(1, 2, 3)] })).toEqual({
      input: 1,
      output: 5,
      cache: { read: 0, write: 0 },
    })
  })

  test("carries cache read and write through", () => {
    expect(messageTokenUsage({ parts: [step(1, 1, 0, 400, 40)] })).toEqual({
      input: 1,
      output: 1,
      cache: { read: 400, write: 40 },
    })
  })

  test("falls back to message totals when no receipts are loaded", () => {
    expect(
      messageTokenUsage({
        parts: [{ type: "text" }],
        tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 5, write: 1 } },
      }),
    ).toEqual({ input: 7, output: 5, cache: { read: 5, write: 1 } })
  })

  test("is zero when neither receipts nor message totals exist", () => {
    expect(messageTokenUsage({ parts: [] })).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })
})
