// Code Mode resource limits (borrow C28). The interpreter enforces timeoutMs, maxToolCalls, and
// maxOutputBytes independently, and every one of them defaults to "no limit", so these tests pin both
// halves of the fork's change: the defaults themselves, and the wiring that hands them to the runtime.
// A wedged program is interrupted, a runaway call loop is refused by name, and a huge result is
// truncated with the truncation reported in the result.
import { describe, expect, test } from "bun:test"
import { CodeMode } from "@opencode/codemode"
import { Effect, Schema } from "effect"
import type { Context, Info } from "@opencode/schema/tool"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { it } from "../lib/effect"

const echo: Info = {
  name: "echo",
  description: "Echo",
  input: Schema.Struct({}),
  execute: () => Effect.succeed({ output: "ok" }),
}
const wedged: Info = {
  name: "wedged",
  description: "Never resolves",
  input: Schema.Struct({}),
  execute: () => Effect.never,
}

const inventory = {
  tools: new Map([
    ["echo", echo],
    ["wedged", wedged],
  ]),
}

const context = {
  sessionID: "ses_codemode_limits",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  progress: () => Effect.void,
} as unknown as Context

/** Runs one program through the execute tool and returns its formatted output. */
const run = (code: string, limits?: CodeMode.ExecutionLimits) =>
  Effect.gen(function* () {
    const tool = CodeModeTool.create(
      inventory,
      (_name, registration, input) => registration.execute(input, context),
      limits,
    )
    const result = yield* tool.execute({ code }, context)
    return (result.output as { readonly output: string }).output
  })

describe("Code Mode limits", () => {
  test("the fork's defaults are all set, and none of them is unbounded", () => {
    expect(CodeModeTool.LIMITS.timeoutMs).toBeGreaterThan(0)
    expect(CodeModeTool.LIMITS.maxToolCalls).toBeGreaterThan(0)
    expect(CodeModeTool.LIMITS.maxOutputBytes).toBeGreaterThan(0)
  })

  // Real clock: the timeout is a wall-clock limit, and TestClock would only fire it if the test moved
  // the clock itself - which is exactly the bug this test exists to catch.
  it.live("interrupts a program that waits forever", () =>
    Effect.gen(function* () {
      const output = yield* run("await tools.wedged()", { timeoutMs: 100 })
      expect(output).toContain("timed out after 100ms")
    }),
  )

  it.effect("refuses a program past its tool-call limit, naming the limit", () =>
    Effect.gen(function* () {
      // Under the limit the loop is fine: the limit has to allow a fan-out, not only forbid one.
      expect(yield* run("for (let i = 0; i < 3; i++) await tools.echo({})", { maxToolCalls: 5 })).not.toContain(
        "tool-call limit",
      )
      const refused = yield* run("for (let i = 0; i < 6; i++) await tools.echo({})", { maxToolCalls: 5 })
      expect(refused).toContain("tool-call limit of 5")
    }),
  )

  it.effect("applies the default call limit when the host passes none", () =>
    Effect.gen(function* () {
      const refused = yield* run(`for (let i = 0; i <= ${CodeModeTool.LIMITS.maxToolCalls}; i++) await tools.echo({})`)
      expect(refused).toContain(`tool-call limit of ${CodeModeTool.LIMITS.maxToolCalls}`)
    }),
  )

  it.effect("truncates an oversized result and says that it did", () =>
    Effect.gen(function* () {
      const output = yield* run('return "x".repeat(5000)', { maxOutputBytes: 256 })
      expect(output).toContain("result truncated")
      expect(output.length).toBeLessThan(1000)
    }),
  )
})
