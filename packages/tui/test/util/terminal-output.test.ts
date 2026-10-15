import { describe, expect, test } from "bun:test"
import { sanitizeTerminalOutput, sanitizeTerminalValue } from "../../src/util/terminal-output"

// Payloads that a command, a file, or a model can carry into a rendered frame. Each one is a terminal
// command when the receiving terminal parses it: OSC 52 writes the clipboard, `\x1b[2J` clears the screen,
// and the C1 and spliced forms survive `strip-ansi` because they are not well-formed sequences.
const CLEAR = "\u001b[2J"
const OSC52 = "\u001b]52;c;QQ==\u0007"
const C1_CSI = "\u009b31m"
const C1_OSC = "\u009d52;c;QQ==\u009c"
const BARE = "\u0000\u0008"
const SPLICED = "\u001b\u0000[31m"
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

describe("sanitizeTerminalOutput", () => {
  for (const [name, payload] of [
    ["a CSI clear", CLEAR],
    ["an OSC 52 clipboard write", OSC52],
    ["a C1 CSI", C1_CSI],
    ["a C1 OSC", C1_OSC],
    ["a bare NUL and backspace", BARE],
    ["an escape spliced with a NUL", SPLICED],
  ] as const) {
    test(`drops ${name}`, () => {
      const result = sanitizeTerminalOutput(`safe${payload}text`)
      expect(result).not.toMatch(CONTROL)
      expect(result).toContain("safe")
      expect(result).toContain("text")
    })
  }

  test("keeps line structure and drops CR", () => {
    expect(sanitizeTerminalOutput("a\tb\r\nc\rd")).toBe("a\tb\nc\nd")
  })

  test("leaves plain text alone", () => {
    expect(sanitizeTerminalOutput("plain text")).toBe("plain text")
  })
})

describe("sanitizeTerminalValue", () => {
  test("sanitizes every string in a JSON-shaped value", () => {
    const result = sanitizeTerminalValue({
      path: `a${CLEAR}b`,
      nested: { text: `c${OSC52}d` },
      list: [`e${BARE}f`, 2, null, true],
    })

    expect(result).toEqual({
      path: "ab",
      nested: { text: "cd" },
      list: ["ef", 2, null, true],
    })
  })

  test("sanitizes object keys", () => {
    const value: Record<string, string> = { [`a${CLEAR}b`]: "value" }

    expect(sanitizeTerminalValue(value)).toEqual({ ab: "value" })
  })

  test("leaves non-plain values untouched", () => {
    const date = new Date(0)
    const map = new Map()
    const result = sanitizeTerminalValue({ date, map })

    expect(result.date).toBe(date)
    expect(result.map).toBe(map)
  })

  test("passes primitives through", () => {
    expect(sanitizeTerminalValue(1)).toBe(1)
    expect(sanitizeTerminalValue(null)).toBeNull()
    expect(sanitizeTerminalValue(undefined)).toBeUndefined()
  })
})
