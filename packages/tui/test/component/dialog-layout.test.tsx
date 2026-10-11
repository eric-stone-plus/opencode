/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup, type ParentProps } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { Dialog, DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

type Size = "medium" | "large" | "xlarge"

const SIZES: Size[] = ["medium", "large", "xlarge"]

type PanelBox = { x: number; y: number; width: number; height: number }

type TestApp = Awaited<ReturnType<typeof mountDialog>>

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountDialog(input: {
  width: number
  height: number
  size?: Size
  contentRows?: number
  header?: boolean
  tailMarker?: boolean
  pinnedHeader?: boolean
  onClose?: () => void
}) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Dialog
                size={input.size}
                onClose={input.onClose ?? (() => {})}
                header={input.pinnedHeader ? () => <text>HEADER-MARKER</text> : undefined}
              >
                {input.header ? <text>HEADER-MARKER</text> : null}
                <box height={input.contentRows ?? 4} />
                {input.tailMarker ? <text>LAST-MARKER</text> : null}
              </Dialog>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width, height: input.height },
  )
  await app.renderOnce()
  // ThemeProvider gates its subtree on async theme resolution ("ready"),
  // so the dialog mounts on a later frame.
  await wait(() => app.renderer.root.findDescendantById("dialog-panel") !== undefined)
  await app.renderOnce()
  return app
}

function panelBox(app: TestApp): PanelBox {
  const panel = app.renderer.root.findDescendantById("dialog-panel")
  if (!panel) throw new Error("dialog panel not mounted")
  return { x: panel.x, y: panel.y, width: panel.width, height: panel.height }
}

function expectWithinBounds(termW: number, termH: number, panel: PanelBox) {
  expect(panel.x).toBeGreaterThanOrEqual(0)
  expect(panel.y).toBeGreaterThanOrEqual(0)
  expect(panel.x + panel.width).toBeLessThanOrEqual(termW)
  expect(panel.y + panel.height).toBeLessThanOrEqual(termH)
}

function expectCentered(termW: number, termH: number, panel: PanelBox) {
  expectWithinBounds(termW, termH, panel)
  const left = panel.x
  const right = termW - panel.x - panel.width
  const top = panel.y
  const bottom = termH - panel.y - panel.height
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1)
}

// Rows of scrollable overflow left in the dialog content area; throws when the
// dialog has no scrollable content region at all.
function dialogScrollRange(app: TestApp): number {
  const scroll = app.renderer.root.findDescendantById("dialog-scroll") as ScrollBoxRenderable | undefined
  if (!scroll) throw new Error("dialog content is not scrollable")
  return scroll.scrollHeight - scroll.height
}

// Drive the dialog to the end of its content the way a user would: mouse wheel
// over the panel. One synthetic notch scrolls several rows (scroll acceleration),
// 40 notches cover any content this suite mounts.
async function scrollDialogToBottom(app: TestApp) {
  const panel = panelBox(app)
  const x = panel.x + Math.floor(panel.width / 2)
  const y = panel.y + Math.floor(panel.height / 2)
  for (let i = 0; i < 40; i++) {
    await app.mockMouse.scroll(x, y, "down")
    await app.renderOnce()
  }
  await app.renderOnce()
}

describe("dialog layout", () => {
  for (const size of SIZES) {
    test(`centers the ${size} dialog in a wide landscape viewport`, async () => {
      const app = await mountDialog({ width: 200, height: 50, size, contentRows: 6 })
      try {
        expectCentered(200, 50, panelBox(app))
      } finally {
        app.renderer.destroy()
      }
    })
  }

  for (const size of SIZES) {
    for (const viewport of [
      { width: 80, height: 24 },
      { width: 60, height: 20 },
    ]) {
      test(`centers the ${size} dialog in a ${viewport.width}x${viewport.height} viewport`, async () => {
        const app = await mountDialog({ ...viewport, size, contentRows: 6 })
        try {
          expectCentered(viewport.width, viewport.height, panelBox(app))
        } finally {
          app.renderer.destroy()
        }
      })
    }
  }

  const widthCases: { term: { width: number; height: number }; size: Size; expected: number }[] = [
    { term: { width: 200, height: 50 }, size: "xlarge", expected: 116 },
    { term: { width: 200, height: 50 }, size: "medium", expected: 60 },
    { term: { width: 80, height: 24 }, size: "xlarge", expected: 78 },
    { term: { width: 60, height: 20 }, size: "medium", expected: 58 },
    { term: { width: 20, height: 5 }, size: "large", expected: 18 },
  ]

  for (const c of widthCases) {
    test(`panel width is ${c.expected} at ${c.term.width}x${c.term.height} (${c.size})`, async () => {
      const app = await mountDialog({ ...c.term, size: c.size, contentRows: 3 })
      try {
        const panel = panelBox(app)
        expect(panel.width).toBe(c.expected)
        expect(panel.width).toBeLessThanOrEqual(c.term.width - 2)
      } finally {
        app.renderer.destroy()
      }
    })
  }

  test("clamps panel height to the terminal height", async () => {
    const app = await mountDialog({ width: 80, height: 20, contentRows: 50 })
    try {
      const panel = panelBox(app)
      expect(panel.height).toBeLessThanOrEqual(20)
      expect(panel.height).toBe(20)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the dialog header visible when content overflows a short terminal", async () => {
    const app = await mountDialog({ width: 40, height: 8, contentRows: 40, header: true })
    try {
      expect(app.captureCharFrame()).toContain("HEADER-MARKER")
    } finally {
      app.renderer.destroy()
    }
  })

  test("re-adapts when the terminal shape changes", async () => {
    const app = await mountDialog({ width: 200, height: 50, contentRows: 6 })
    try {
      expectCentered(200, 50, panelBox(app))
      app.resize(60, 20)
      await app.renderOnce()
      const portrait = panelBox(app)
      expect(portrait.width).toBe(58)
      expectCentered(60, 20, portrait)
      app.resize(80, 40)
      await app.renderOnce()
      expectCentered(80, 40, panelBox(app))
    } finally {
      app.renderer.destroy()
    }
  })

  test("stays in bounds on an extreme 20x5 viewport", async () => {
    const app = await mountDialog({ width: 20, height: 5, contentRows: 8 })
    try {
      expectWithinBounds(20, 5, panelBox(app))
    } finally {
      app.renderer.destroy()
    }
  })

  test("stays in bounds on an extreme 500x200 viewport", async () => {
    const app = await mountDialog({ width: 500, height: 200, contentRows: 8 })
    try {
      expectWithinBounds(500, 200, panelBox(app))
    } finally {
      app.renderer.destroy()
    }
  })
})

// Landscape = wide + short viewports (rotated phone/tablet terminals). Realistic
// /usage content is ~30 rows (session + meta + usage + context + footnotes), so it
// overflows these heights; every row must stay reachable by scrolling.
describe("dialog content scrolling", () => {
  for (const viewport of [
    { width: 200, height: 30 },
    { width: 160, height: 24 },
    { width: 120, height: 20 },
  ]) {
    test(`landscape ${viewport.width}x${viewport.height}: tall content is fully reachable`, async () => {
      const app = await mountDialog({
        ...viewport,
        size: "large",
        contentRows: 29,
        tailMarker: true,
        pinnedHeader: true,
      })
      try {
        expectCentered(viewport.width, viewport.height, panelBox(app))
        // Reproduction: the tail rows are clipped on open (the reported bug).
        expect(app.captureCharFrame()).not.toContain("LAST-MARKER")
        await scrollDialogToBottom(app)
        const frame = app.captureCharFrame()
        // L1: every row of the dialog is reachable end-to-end.
        expect(frame).toContain("LAST-MARKER")
        // L1/G3: the header/close affordance stays visible while scrolled down.
        expect(frame).toContain("HEADER-MARKER")
      } finally {
        app.renderer.destroy()
      }
    })
  }

  test("portrait 80x24: tall content is reachable and the dialog stays centered", async () => {
    const app = await mountDialog({
      width: 80,
      height: 24,
      size: "large",
      contentRows: 29,
      tailMarker: true,
      pinnedHeader: true,
    })
    try {
      expectCentered(80, 24, panelBox(app))
      expect(app.captureCharFrame()).not.toContain("LAST-MARKER")
      await scrollDialogToBottom(app)
      const frame = app.captureCharFrame()
      expect(frame).toContain("LAST-MARKER")
      expect(frame).toContain("HEADER-MARKER")
    } finally {
      app.renderer.destroy()
    }
  })

  test("header/close stays visible from scroll top to bottom", async () => {
    const app = await mountDialog({
      width: 200,
      height: 30,
      size: "large",
      contentRows: 29,
      tailMarker: true,
      pinnedHeader: true,
    })
    try {
      expect(app.captureCharFrame()).toContain("HEADER-MARKER")
      await scrollDialogToBottom(app)
      expect(app.captureCharFrame()).toContain("HEADER-MARKER")
    } finally {
      app.renderer.destroy()
    }
  })

  test("content overflow has a non-zero scroll range", async () => {
    const app = await mountDialog({
      width: 120,
      height: 20,
      size: "large",
      contentRows: 29,
      tailMarker: true,
      pinnedHeader: true,
    })
    try {
      expect(dialogScrollRange(app)).toBeGreaterThan(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("clicking inside the scrolled panel does not dismiss the dialog", async () => {
    let closes = 0
    const app = await mountDialog({
      width: 200,
      height: 30,
      size: "large",
      contentRows: 29,
      tailMarker: true,
      onClose: () => {
        closes++
      },
    })
    try {
      const panel = panelBox(app)
      await app.mockMouse.click(panel.x + Math.floor(panel.width / 2), panel.y + Math.floor(panel.height / 2))
      await app.renderOnce()
      expect(closes).toBe(0)
      await app.mockMouse.click(1, 1)
      await app.renderOnce()
      expect(closes).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("escape still closes the dialog after clicking inside its scroll area", async () => {
    const config = createTuiResolvedConfig()
    function KeymapHost(props: ParentProps) {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const off = registerOpencodeKeymap(keymap, renderer, config)
      onCleanup(off)
      return <OpencodeKeymapProvider keymap={keymap}>{props.children}</OpencodeKeymapProvider>
    }
    function Opener() {
      const dialog = useDialog()
      function Content() {
        dialog.setHeader(() => <text>HEADER-MARKER</text>)
        return (
          <>
            <box height={29} />
            <text>LAST-MARKER</text>
          </>
        )
      }
      dialog.replace(() => <Content />)
      return null
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <KeymapHost>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <Opener />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </KeymapHost>
        </TestTuiContexts>
      ),
      { width: 200, height: 30, kittyKeyboard: true },
    )
    try {
      await app.renderOnce()
      await wait(() => app.renderer.root.findDescendantById("dialog-panel") !== undefined)
      await app.renderOnce()
      // The provider path pins the header set through the dialog context.
      expect(app.captureCharFrame()).toContain("HEADER-MARKER")
      const panel = panelBox(app)
      await app.mockMouse.click(panel.x + Math.floor(panel.width / 2), panel.y + Math.floor(panel.height / 2))
      await app.renderOnce()
      expect(app.renderer.root.findDescendantById("dialog-panel")).toBeDefined()
      app.mockInput.pressEscape()
      await app.renderOnce()
      expect(app.renderer.root.findDescendantById("dialog-panel")).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
