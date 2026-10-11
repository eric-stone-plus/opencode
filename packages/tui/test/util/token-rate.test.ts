import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, StepFinishPart, ToolPart } from "@opencode-ai/sdk/v2"
import { formatRate, formatTokenRate, tokensPerSecond, usageStrip } from "../../src/util/token-rate"

function assistant(id: string, time: { created: number; completed?: number }): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time,
    parentID: "msg_parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function stepFinish(messageID: string, output: number): StepFinishPart {
  return {
    id: `prt_${messageID}_sf_${output}`,
    sessionID: "ses_1",
    messageID,
    type: "step-finish",
    reason: "tool-use",
    cost: 0,
    tokens: { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function tool(messageID: string, start: number, end: number): ToolPart {
  return {
    id: `prt_${messageID}_tool_${start}`,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID: `call_${start}`,
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "bash",
      metadata: {},
      time: { start, end },
    },
  }
}

describe("util.token-rate", () => {
  describe("tokensPerSecond", () => {
    test("rate is summed output tokens over summed request seconds across completed messages", () => {
      const messages: Message[] = [
        assistant("msg_a", { created: 0, completed: 2000 }),
        assistant("msg_b", { created: 3000, completed: 6000 }),
      ]
      const parts = {
        msg_a: [stepFinish("msg_a", 1000)],
        msg_b: [stepFinish("msg_b", 2000)],
      }
      expect(tokensPerSecond(messages, parts)).toBe(600)
    })

    test("sums every step-finish receipt inside one multi-step message", () => {
      const messages: Message[] = [assistant("msg_a", { created: 0, completed: 8000 })]
      const parts = {
        msg_a: [stepFinish("msg_a", 100), tool("msg_a", 2000, 6000), stepFinish("msg_a", 300)],
      }
      expect(tokensPerSecond(messages, parts)).toBe(100)
    })

    test("tool execution time is excluded from the denominator", () => {
      const messages: Message[] = [assistant("msg_a", { created: 0, completed: 10000 })]
      const parts = {
        msg_a: [stepFinish("msg_a", 200), tool("msg_a", 1000, 9000)],
      }
      expect(tokensPerSecond(messages, parts)).toBe(100)
    })

    test("an in-flight message contributes nothing and keeps the last measured average", () => {
      const done = assistant("msg_a", { created: 0, completed: 2000 })
      const inflight = assistant("msg_b", { created: 3000 })
      const parts = {
        msg_a: [stepFinish("msg_a", 1000)],
        msg_b: [stepFinish("msg_b", 999999)],
      }
      expect(tokensPerSecond([done, inflight], parts)).toBe(500)
      expect(tokensPerSecond([done], parts)).toBe(500)
    })

    test("omits the rate when no measurement exists", () => {
      expect(tokensPerSecond([], {})).toBeUndefined()
      expect(
        tokensPerSecond([assistant("msg_a", { created: 0 })], { msg_a: [stepFinish("msg_a", 100)] }),
      ).toBeUndefined()
      expect(
        tokensPerSecond([assistant("msg_a", { created: 0, completed: 2000 })], { msg_a: [] }),
      ).toBeUndefined()
      expect(tokensPerSecond([assistant("msg_a", { created: 0, completed: 2000 })], {})).toBeUndefined()
      expect(
        tokensPerSecond([assistant("msg_a", { created: 0, completed: 2000 })], { msg_a: [stepFinish("msg_a", 0)] }),
      ).toBeUndefined()
      expect(
        tokensPerSecond([assistant("msg_a", { created: 0, completed: 2000 })], {
          msg_a: [stepFinish("msg_a", 100), tool("msg_a", 0, 2000)],
        }),
      ).toBeUndefined()
    })

    test("messages without step-finish receipts never enter the average", () => {
      const messages: Message[] = [
        assistant("msg_a", { created: 0, completed: 2000 }),
        assistant("msg_b", { created: 3000, completed: 30000 }),
      ]
      const parts = {
        msg_a: [stepFinish("msg_a", 1000)],
        msg_b: [tool("msg_b", 3100, 29000)],
      }
      expect(tokensPerSecond(messages, parts)).toBe(500)
    })

    test("concurrent tool spans are unioned, not summed", () => {
      const messages: Message[] = [assistant("msg_a", { created: 0, completed: 20000 })]
      const parts = {
        msg_a: [stepFinish("msg_a", 800), tool("msg_a", 5000, 11000), tool("msg_a", 5500, 12000)],
      }
      // wall 20s minus the union 5000-12000 (7s), not the sum (13s)
      expect(tokensPerSecond(messages, parts)).toBeCloseTo(800 / 13, 9)
    })

    test("malformed time fields never leak NaN into the rate", () => {
      const broken = {
        ...assistant("msg_a", { created: 0, completed: 2000 }),
        time: { completed: 2000 },
      } as unknown as Message
      expect(tokensPerSecond([broken], { msg_a: [stepFinish("msg_a", 1000)] })).toBeUndefined()
    })
  })

  describe("usageStrip", () => {
    test("includes the rate cell last when measured", () => {
      expect(usageStrip({ context: "143.6K (14%)", cost: "$1.56", rate: "42 tok/s" })).toBe(
        "143.6K (14%) · $1.56 · 42 tok/s",
      )
      expect(usageStrip({ context: "143.6K (14%)", cost: undefined, rate: "42 tok/s" })).toBe(
        "143.6K (14%) · 42 tok/s",
      )
    })

    test("omits the rate cell when no measurement exists", () => {
      expect(usageStrip({ context: "143.6K (14%)", cost: "$1.56", rate: undefined })).toBe("143.6K (14%) · $1.56")
    })
  })

  describe("formatRate", () => {
    test("one decimal below 10 tok/s, integer otherwise (codewhale format_rate)", () => {
      expect(formatRate(0)).toBe("0.0")
      expect(formatRate(7.5)).toBe("7.5")
      expect(formatRate(7.55)).toBe("7.5")
      expect(formatRate(9.95)).toBe("9.9")
      expect(formatRate(9.96)).toBe("10.0")
      expect(formatRate(10.5)).toBe("10")
      expect(formatRate(10.6)).toBe("11")
      expect(formatRate(42.3)).toBe("42")
    })

    test("rounds exact decimal ties half-to-even like Rust {:.N}", () => {
      expect(formatRate(0.25)).toBe("0.2")
      expect(formatRate(1.25)).toBe("1.2")
      expect(formatRate(2.25)).toBe("2.2")
      expect(formatRate(11.5)).toBe("12")
    })

    test("label carries tok/s", () => {
      expect(formatTokenRate(42.3)).toBe("42 tok/s")
      expect(formatTokenRate(7.55)).toBe("7.5 tok/s")
    })
  })
})
