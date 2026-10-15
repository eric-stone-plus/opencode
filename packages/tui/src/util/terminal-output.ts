import stripAnsi from "strip-ansi"

/**
 * Bytes produced by a shell command - or by a model-authored command line - reach a real terminal through
 * this TUI, so they are untrusted input to the terminal's parser.
 *
 * `stripAnsi` only removes *well-formed* sequences. A bare ESC, a C1 byte (0x9b CSI / 0x9d OSC / 0x9c ST),
 * a lone control byte (NUL, backspace), or a NUL spliced into an introducer (`\x1b\x00[31m`, which the
 * ANSI regex cannot match) survives it and is still interpreted by the terminal - OSC 52 writes the
 * clipboard, `\x1b[2J` clears the screen, `\x1b]0;...` rewrites the title. Strip every control character
 * after the sequence pass, keeping only the line structure the renderer lays out on.
 *
 * Same shape as the title sanitizer in `src/attention.ts`; a shell pane needs tabs and newlines kept, so
 * those two survive here and everything else (including CR, normalized to a newline first) does not.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

export function sanitizeTerminalOutput(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
}

/**
 * Same sanitizer over a JSON-shaped value: every string inside a tool input, metadata blob or state record
 * is untrusted (a file path, a file's content, an MCP reply), and the renderers pick those fields out by
 * name. Sanitizing the projection once keeps every view honest instead of relying on each field's sink.
 */
export function sanitizeTerminalValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeTerminalOutput(value) as T
  if (Array.isArray(value)) return value.map((item) => sanitizeTerminalValue(item)) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeTerminalOutput(key), sanitizeTerminalValue(item)]),
    ) as T
  }
  return value
}
