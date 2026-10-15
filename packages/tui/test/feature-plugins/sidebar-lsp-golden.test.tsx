/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarLsp } from "../../src/feature-plugins/sidebar/lsp"
import { goldenFrames } from "../util/golden"

function context(servers: Array<{ id: string; name: string; root: string; status: "connected" | "error" }>) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { success: { base: color }, error: { base: color } },
      },
    },
    storage: { store: () => [{ open: true }, async () => {}] },
    data: {
      session: { get: () => ({ location: { directory: "/workspace" } }) },
      location: { lspStatus: { list: () => servers } },
    },
  } as unknown as Context
}

test("golden: the LSP sidebar across the shipped widths", async () => {
  expect(
    await goldenFrames(() => (
      <SidebarLsp
        context={context([
          { id: "typescript", name: "typescript", root: "/workspace", status: "connected" },
          { id: "gopls", name: "gopls", root: "/workspace", status: "error" },
        ])}
        sessionID="session"
      />
    )),
  ).toMatchSnapshot()
})

test("golden: the idle LSP sidebar hint", async () => {
  expect(
    await goldenFrames(() => <SidebarLsp context={context([])} sessionID="session" />),
  ).toMatchSnapshot()
})
