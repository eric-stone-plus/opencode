import { expect, test } from "bun:test"
import { stripTerminalControl } from "./terminal-text.js"

test("stripTerminalControl keeps plain text intact", () => {
  expect(stripTerminalControl("Model title")).toBe("Model title")
})

test("stripTerminalControl defuses OSC and CSI payloads", () => {
  const osc = stripTerminalControl("\x1b]52;c;Y3VybCB8c2g=\x07cleared")
  expect(osc).not.toContain("\x1b")
  expect(osc).not.toContain("\x07")
  expect(osc).toContain("cleared")
  expect(stripTerminalControl("\x1b[31mred\x1b[0m")).toBe(" [31mred [0m")
})

test("stripTerminalControl flattens line breaks", () => {
  expect(stripTerminalControl("line1\r\nline2")).toBe("line1  line2")
})
