import { describe, expect, test } from "bun:test"
import { toolEntryBody } from "../../src/mini/tool"
import { entryBody } from "../../src/mini/entry.body"

// Mini mode assembles its scrollback from the same untrusted stream as the full TUI. These are the two
// projection functions that build an entry body; neither may carry a control byte into the terminal.
const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"

function body(value: unknown) {
  return JSON.stringify(value)
}

describe("mini entry bodies", () => {
  test("tool progress body drops control bytes", () => {
    const text = `MCPOUT-${CLEAR}-tail`
    const commit = {
      kind: "tool",
      source: "tool",
      text,
      phase: "progress",
      toolState: "running",
      tool: "mcp_evil_echo",
      partID: "part-1",
      messageID: "msg-1",
    } as unknown as Parameters<typeof toolEntryBody>[0]

    expect(body(toolEntryBody(commit, text))).not.toContain("\\u001b")
    expect(body(entryBody(commit))).not.toContain("\\u001b")
  })

  test("assistant stream body drops control bytes", () => {
    const text = `MODEL-${OSC}-tail`
    const commit = {
      kind: "assistant",
      source: "assistant",
      text,
      phase: "progress",
      partID: "part-2",
      messageID: "msg-1",
    } as unknown as Parameters<typeof entryBody>[0]

    expect(body(entryBody(commit))).not.toContain("\\u001b")
    expect(body(entryBody(commit))).toContain("MODEL-")
  })
})
