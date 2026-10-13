import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { formatRate, formatTokenRate, streamingOutputEstimate, timeToFirstToken, tokensPerSecond } from "../../src/util/token-rate"

function step(input: {
  created: number
  streamed?: number
  completed?: number
  output?: number
  reasoning?: number
  content?: SessionMessageAssistant["content"]
  error?: SessionMessageAssistant["error"]
}): SessionMessageAssistant {
  return {
    type: "assistant",
    id: `msg_${input.created}`,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: input.content ?? [],
    time: { created: input.created, streamed: input.streamed, completed: input.completed },
    ...(input.output === undefined
      ? {}
      : {
          tokens: {
            input: 0,
            output: input.output,
            reasoning: input.reasoning ?? 0,
            cache: { read: 0, write: 0 },
          },
        }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

const reasoning = (created: number): SessionMessageAssistant["content"][number] => ({
  type: "reasoning",
  text: "",
  time: { created },
})
const text = (): SessionMessageAssistant["content"][number] => ({ type: "text", text: "answer" })
const tool = (created: number): SessionMessageAssistant["content"][number] => ({
  type: "tool",
  id: `call_${created}`,
  name: "read",
  state: { status: "running", input: {}, metadata: {} },
  time: { created },
})
const user = (created: number): SessionMessageInfo => ({
  type: "user",
  id: `user_${created}`,
  text: "",
  time: { created },
})
const chunk = (type: "text" | "reasoning", text: string): SessionMessageAssistant["content"][number] => ({
  type,
  text,
})

describe("util.token-rate", () => {
  describe("tokensPerSecond", () => {
    test("is summed output tokens over summed provider seconds across settled steps", () => {
      const messages = [
        user(0),
        step({ created: 0, streamed: 2_000, completed: 2_500, output: 1_000 }),
        step({ created: 3_000, streamed: 6_000, completed: 6_500, output: 2_000 }),
      ]
      expect(tokensPerSecond(messages)).toBe(600)
    })

    test("counts reasoning tokens, which take as long to generate as the visible output", () => {
      expect(tokensPerSecond([step({ created: 0, streamed: 4_000, output: 100, reasoning: 300 })])).toBe(100)
    })

    test("leaves tool execution out of the denominator because the clock stops at the end of the response body", () => {
      // 1 s of provider time, then a 9 s tool before the step completes
      const messages = [step({ created: 0, streamed: 1_000, completed: 10_000, output: 200 })]
      expect(tokensPerSecond(messages)).toBe(200)
    })

    test("an in-flight step contributes nothing and the average holds its last value", () => {
      const settled = step({ created: 0, streamed: 2_000, completed: 2_000, output: 1_000 })
      const streaming = step({ created: 3_000, output: 999_999 })
      expect(tokensPerSecond([settled, streaming])).toBe(500)
      expect(tokensPerSecond([settled])).toBe(500)
    })

    test("is undefined until a step has both usage and a positive duration", () => {
      expect(tokensPerSecond([])).toBeUndefined()
      expect(tokensPerSecond([user(0)])).toBeUndefined()
      expect(tokensPerSecond([step({ created: 0, streamed: 2_000 })])).toBeUndefined()
      expect(tokensPerSecond([step({ created: 0, output: 100 })])).toBeUndefined()
      expect(tokensPerSecond([step({ created: 5_000, streamed: 5_000, output: 100 })])).toBeUndefined()
      expect(tokensPerSecond([step({ created: 5_000, streamed: 4_000, output: 100 })])).toBeUndefined()
      expect(tokensPerSecond([step({ created: 0, streamed: 2_000, output: 0 })])).toBeUndefined()
    })

    test("a step without usage never dilutes the average", () => {
      const messages = [
        step({ created: 0, streamed: 2_000, output: 1_000 }),
        step({ created: 3_000, streamed: 30_000 }),
      ]
      expect(tokensPerSecond(messages)).toBe(500)
    })

    test("ignores messages that are not model calls", () => {
      const messages: SessionMessageInfo[] = [
        user(0),
        { type: "idle", id: "idle_1", outcome: "succeeded", time: { created: 1 } },
        step({ created: 0, streamed: 1_000, output: 100 }),
      ]
      expect(tokensPerSecond(messages)).toBe(100)
    })
  })

  describe("timeToFirstToken", () => {
    test("averages dispatch to first reasoning over settled steps", () => {
      const messages = [
        step({ created: 0, completed: 4_000, content: [reasoning(800), text()] }),
        step({ created: 5_000, completed: 9_000, content: [reasoning(6_200)] }),
      ]
      expect(timeToFirstToken(messages)).toBe(1_000)
    })

    test("times every call, including the ones that follow tool results", () => {
      const messages = [
        step({ created: 0, completed: 4_000, content: [reasoning(500), tool(1_000)] }),
        step({ created: 6_000, completed: 9_000, content: [reasoning(7_500), text()] }),
      ]
      expect(timeToFirstToken(messages)).toBe(1_000)
    })

    test("only reasoning carries a start time, so a call that opens with text or a tool is untimed", () => {
      expect(timeToFirstToken([step({ created: 0, completed: 4_000, content: [text()] })])).toBeUndefined()
      expect(
        timeToFirstToken([step({ created: 0, completed: 4_000, content: [tool(900), reasoning(2_000)] })]),
      ).toBeUndefined()
      expect(
        timeToFirstToken([step({ created: 0, completed: 4_000, content: [{ type: "reasoning", text: "" }] })]),
      ).toBeUndefined()
    })

    test("untimed steps do not dilute the average", () => {
      const messages = [
        step({ created: 0, completed: 4_000, content: [reasoning(800)] }),
        step({ created: 5_000, completed: 9_000, content: [text()] }),
      ]
      expect(timeToFirstToken(messages)).toBe(800)
    })

    test("a step still streaming or ended in error is not sampled", () => {
      expect(timeToFirstToken([step({ created: 0, content: [reasoning(500)] })])).toBeUndefined()
      expect(
        timeToFirstToken([
          step({
            created: 0,
            completed: 2_000,
            content: [reasoning(500)],
            error: { type: "provider", message: "boom" },
          }),
        ]),
      ).toBeUndefined()
    })

    test("a negative gap from clock skew is discarded", () => {
      expect(timeToFirstToken([step({ created: 1_000, completed: 4_000, content: [reasoning(500)] })])).toBeUndefined()
    })

    test("is undefined without any step", () => {
      expect(timeToFirstToken([])).toBeUndefined()
      expect(timeToFirstToken([user(0)])).toBeUndefined()
    })
  })

  describe("streamingOutputEstimate", () => {
    test("estimates the in-flight step at one token per four characters, rounding up", () => {
      expect(streamingOutputEstimate([step({ created: 0, content: [chunk("text", "abcd")] })])).toBe(1)
      expect(streamingOutputEstimate([step({ created: 0, content: [chunk("text", "abcde")] })])).toBe(2)
    })

    test("counts reasoning characters, which stream for most of a thinking phase", () => {
      expect(streamingOutputEstimate([step({ created: 0, content: [chunk("reasoning", "abcdefgh")] })])).toBe(2)
    })

    test("adds every delivered text and reasoning part and ignores tool parts", () => {
      const messages = [
        step({ created: 0, content: [chunk("text", "abcd"), chunk("reasoning", "abcdefgh"), tool(100)] }),
      ]
      expect(streamingOutputEstimate(messages)).toBe(3)
    })

    test("settled steps contribute nothing — their receipts are the session totals", () => {
      const filled = step({
        created: 0,
        streamed: 1_000,
        completed: 1_200,
        content: [chunk("text", "a".repeat(400))],
      })
      expect(streamingOutputEstimate([filled])).toBe(0)
    })

    test("only the streaming step counts, even beside settled content", () => {
      const messages = [
        step({ created: 0, streamed: 1_000, completed: 1_200, content: [chunk("text", "a".repeat(400))] }),
        step({ created: 2_000, content: [chunk("text", "abcd")] }),
      ]
      expect(streamingOutputEstimate(messages)).toBe(1)
    })

    test("is zero with nothing streaming", () => {
      expect(streamingOutputEstimate([])).toBe(0)
      expect(streamingOutputEstimate([user(0)])).toBe(0)
      expect(streamingOutputEstimate([step({ created: 0, content: [] })])).toBe(0)
    })
  })

  describe("formatRate", () => {
    test("one decimal below 10 tok/s, integer otherwise", () => {
      expect(formatRate(0)).toBe("0.0")
      expect(formatRate(7.5)).toBe("7.5")
      expect(formatRate(7.55)).toBe("7.5")
      expect(formatRate(9.95)).toBe("9.9")
      expect(formatRate(9.96)).toBe("10.0")
      expect(formatRate(10.5)).toBe("10")
      expect(formatRate(10.6)).toBe("11")
      expect(formatRate(42.3)).toBe("42")
    })

    test("rounds exact binary ties half-to-even like Rust {:.N}", () => {
      expect(formatRate(0.25)).toBe("0.2")
      expect(formatRate(1.25)).toBe("1.2")
      expect(formatRate(2.25)).toBe("2.2")
      expect(formatRate(11.5)).toBe("12")
    })

    test("the label carries tok/s", () => {
      expect(formatTokenRate(42.3)).toBe("42 tok/s")
      expect(formatTokenRate(7.55)).toBe("7.5 tok/s")
    })
  })
})
