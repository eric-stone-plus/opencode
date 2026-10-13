/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarLsp } from "../../src/feature-plugins/sidebar/lsp"

function context(options?: { servers?: Array<{ id: string; name: string; root: string; status: string }> }) {
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
      location: { lspStatus: { list: () => options?.servers ?? [] } },
    },
  } as unknown as Context
}

test("sidebar shows the idle hint before servers start", async () => {
  const app = await testRender(() => <SidebarLsp context={context()} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("LSP")
    expect(app.captureCharFrame()).toContain("LSPs will activate as files are read")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar lists running language servers by name only", async () => {
  const app = await testRender(
    () =>
      <SidebarLsp
        context={context({
          servers: [
            {
              id: "typescript",
              name: "typescript",
              root: "/very/long/workspace/root/that/would/never/fit/the/sidebar",
              status: "connected",
            },
            { id: "gopls", name: "gopls", root: "/workspace", status: "error" },
          ],
        })}
        sessionID="session"
      />,
    { width: 42, height: 8 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("LSP")
    expect(frame).toContain("typescript")
    expect(frame).toContain("gopls")
    // The rows carry the server name alone; root paths are noise on a sidebar this narrow.
    expect(frame).not.toContain("/very/long")
    expect(frame).not.toContain("/workspace")
    expect(frame).not.toContain("LSPs will activate as files are read")
  } finally {
    app.renderer.destroy()
  }
})
