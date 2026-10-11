/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"

// The fork once patched CodeRenderable to check isDestroyed before warning, because quitting a code-heavy session
// dumped one "TreeSitter client destroyed" stack per queued highlight. opentui 0.5.17 fixed this upstream:
// destroy() bumps the highlight snapshot id, so a rejection that lands afterwards is dropped before it can warn.
// This pins that behavior; if it regresses, the isDestroyed-before-warn hunk has to return to the patch.
test("a highlight that rejects after the renderer is destroyed does not warn", async () => {
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args)
  const mock = new MockTreeSitterClient()
  const pending: Array<(error: Error) => void> = []
  mock.highlightOnce = () => new Promise((_, reject) => void pending.push(reject))
  try {
    const app = await testRender(
      () => (
        <box width={40} height={10}>
          <code
            filetype="typescript"
            content="const answer = 42"
            syntaxStyle={SyntaxStyle.fromStyles({})}
            treeSitterClient={mock}
          />
        </box>
      ),
      { width: 40, height: 10, useThread: false },
    )
    await app.renderOnce()
    expect(pending.length).toBe(1)
    app.renderer.destroy()
    pending.forEach((reject) => reject(new Error("TreeSitter client destroyed")))
    await Bun.sleep(20)
    expect(warnings).toEqual([])
  } finally {
    console.warn = warn
    await mock.destroy().catch(() => {})
  }
})

test("a highlight that fails while the block is alive still warns and falls back to plain text", async () => {
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args)
  const mock = new MockTreeSitterClient()
  mock.highlightOnce = () => Promise.reject(new Error("worker crashed"))
  try {
    const app = await testRender(
      () => (
        <box width={40} height={10}>
          <code
            filetype="typescript"
            content="const answer = 42"
            syntaxStyle={SyntaxStyle.fromStyles({})}
            treeSitterClient={mock}
            drawUnstyledText={false}
          />
        </box>
      ),
      { width: 40, height: 10, useThread: false },
    )
    try {
      await app.renderOnce()
      await Bun.sleep(20)
      await app.renderOnce()
      expect(warnings.length).toBe(1)
      expect(app.captureCharFrame()).toContain("const answer = 42")
    } finally {
      app.renderer.destroy()
    }
  } finally {
    console.warn = warn
    await mock.destroy().catch(() => {})
  }
})
