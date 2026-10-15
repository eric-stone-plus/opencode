/** @jsxImportSource @opentui/solid */
import { expect, setSystemTime, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { createStatusAges, LSP_STALE_AFTER_MS, SidebarLsp, staleLabel } from "../../src/feature-plugins/sidebar/lsp"

function context(options?: {
  servers?: Array<{ id: string; name: string; root: string; status: string }>
  list?: () => Array<{ id: string; name: string; root: string; status: "connected" | "error" }>
}) {
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
      location: { lspStatus: { list: () => options?.list?.() ?? options?.servers ?? [] } },
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

test("sidebar lists a server once when several roots run it", async () => {
  const app = await testRender(
    () =>
      <SidebarLsp
        context={context({
          servers: [
            { id: "typescript", name: "typescript", root: "/workspace", status: "connected" },
            { id: "typescript", name: "typescript", root: "/workspace/packages/app", status: "connected" },
            { id: "gopls", name: "gopls", root: "/workspace", status: "connected" },
          ],
        })}
        sessionID="session"
      />,
    { width: 42, height: 8 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    // The runtime runs one client per (server, root); the sidebar shows the server, not each client.
    expect(frame.match(/typescript/g)).toHaveLength(1)
    expect(frame).toContain("gopls")
    // Two servers stay expanded: the collapse chevron appears only above two rows.
    expect(frame).not.toContain("▼")
  } finally {
    app.renderer.destroy()
  }
})

test("tracks the age of each server's current state", () => {
  const now = 1_000_000
  const ageOf = createStatusAges(() => now)
  const gopls = { id: "gopls", name: "gopls", root: "/workspace", status: "error" as const }

  expect(ageOf([gopls], now).get("gopls")).toBe(0)
  expect(ageOf([gopls], now + 90_000).get("gopls")).toBe(90_000)
  // A state change restarts the clock; an unchanged row keeps its age.
  expect(ageOf([{ ...gopls, status: "connected" }], now + 120_000).get("gopls")).toBe(0)
  expect(ageOf([{ ...gopls, status: "connected" }], now + 150_000).get("gopls")).toBe(30_000)
})

test("labels only an unhealthy state that has been stuck long enough", () => {
  expect(staleLabel("error", LSP_STALE_AFTER_MS - 1)).toBeUndefined()
  expect(staleLabel("error", LSP_STALE_AFTER_MS)).toBe("stale 5m")
  expect(staleLabel("error", 12 * 60_000 + 30_000)).toBe("stale 12m")
  // A connected server is quiet by nature: nothing re-confirms it, and that is not a problem.
  expect(staleLabel("connected", 60 * 60_000)).toBeUndefined()
})

test("marks an unhealthy server as stale once its state is old", async () => {
  const gopls: { id: string; name: string; root: string; status: "connected" | "error" } = {
    id: "gopls",
    name: "gopls",
    root: "/workspace",
    status: "error",
  }
  const [servers, setServers] = createSignal([gopls])
  const app = await testRender(() => <SidebarLsp context={context({ list: () => servers() })} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("gopls")
    expect(app.captureCharFrame()).not.toContain("stale")

    setSystemTime(new Date(Date.now() + 6 * 60_000))
    setServers([gopls, { id: "tsserver", name: "tsserver", root: "/workspace", status: "connected" }])
    await app.waitForFrame((frame) => frame.includes("tsserver"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("stale 6m")
    expect(frame).not.toContain("tsserver stale")
  } finally {
    setSystemTime()
    app.renderer.destroy()
  }
})
