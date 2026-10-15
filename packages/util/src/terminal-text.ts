/**
 * Session titles are model- and import-controlled text that reaches real terminals through several
 * sinks: the exit epilogue writes them between ANSI sequences, `session list` pages them through
 * `less -R`, and setTerminalTitle hands them to the terminal driver. A title is not a safe escape
 * target - OSC 52 writes the clipboard, other sequences clear or rewrite the screen - and control
 * characters carry no meaning in a title, so every sink drops them before rendering.
 */
export function stripTerminalControl(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
}
