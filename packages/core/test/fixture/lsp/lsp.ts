import path from "path"
import { LSPServer } from "@opencode/core/fork/lsp/server"

export const fakeServerPath = path.join(import.meta.dir, "fake-lsp-server.cjs")

/** How to start the scripted fake server; `FAKE_LSP_*` variables in `env` script what it reports. */
export const fakeHandle = (
  cwd: string,
  extra: Pick<LSPServer.Handle, "env" | "initialization"> = {},
): LSPServer.Handle => ({
  command: process.execPath,
  args: [fakeServerPath],
  cwd,
  ...extra,
})

/** A configured server entry (`lsp.<id>`) that runs the fake server. */
export const fakeEntry = (extensions: string[], env: Record<string, string> = {}) => ({
  command: [process.execPath, fakeServerPath],
  extensions,
  env,
})

export const finding = (line: number, message: string, severity = 1) => ({
  range: { start: { line, character: 0 }, end: { line, character: 4 } },
  severity,
  message,
})
