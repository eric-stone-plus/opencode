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
