import { describe, expect, test } from "bun:test"
import { genericToolSummary, parseDiagnostics } from "../../src/routes/session"
import { reasoningContent } from "../../src/routes/session/message-parts"

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"

describe("session projections", () => {
  test("genericToolSummary drops control bytes from the tool name", () => {
    expect(genericToolSummary(`mcp${CLEAR}tool`, { text: "ok" })).toBe("mcptool [text=ok]")
  })
  test("parseDiagnostics drops control bytes from messages", () => {
    const result = parseDiagnostics(
      {
        "a.ts": [
          { severity: 1, message: `bad${CLEAR}line`, range: { start: { line: 1, character: 2 } } },
          { severity: 1, message: `clip${OSC}board`, range: { start: { line: 3, character: 4 } } },
        ],
      },
      "a.ts",
    )

    expect(result).toEqual([
      { message: "badline", range: { start: { line: 1, character: 2 } } },
      { message: "clipboard", range: { start: { line: 3, character: 4 } } },
    ])
  })

  test("reasoningContent drops control bytes and the redacted placeholder", () => {
    expect(reasoningContent({ type: "reasoning", text: `think${CLEAR}ing` })).toBe("thinking")
    expect(reasoningContent({ type: "reasoning", text: "[REDACTED]" })).toBe("")
  })
})
