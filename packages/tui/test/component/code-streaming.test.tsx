/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"

// Regression: while a stream is active the CodeRenderable content setter used
// to skip textBuffer updates whenever (streaming && filetype && !drawUnstyledText),
// and startHighlight results were superseded on every delta. The block froze on
// stale content (or stayed blank) until the stream paused — the "lower half of
// the TUI breaks while the agent keeps running" symptom.

test("streaming code element shows new content before highlights land", async () => {
  const mock = new MockTreeSitterClient()
  const style = SyntaxStyle.fromStyles({})
  const [text, setText] = createSignal("L0")
  const app = await testRender(
    () => (
      <box width={80} height={24}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          treeSitterClient={mock}
          syntaxStyle={style}
          content={text()}
        />
        <text>MARKER-BOTTOM</text>
      </box>
    ),
    { width: 80, height: 24, useThread: false },
  )
  try {
    await app.flush()
    setText("L0\nL1")
    await app.flush()
    await app.renderOnce()
    setText("L0\nL1\nL2")
    await app.flush()
    await app.renderOnce()
    // Content must track the stream even though no highlight has been resolved.
    expect(app.captureCharFrame()).toContain("L2")

    mock.resolveAllHighlightOnce()
    await app.flush()
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("L2")
    expect(app.captureCharFrame()).toContain("MARKER-BOTTOM")
  } finally {
    await mock.destroy().catch(() => {})
    app.renderer.destroy()
  }
}, 30000)

test("streaming markdown fenced code block tracks content while highlights are pending", async () => {
  const mock = new MockTreeSitterClient()
  const style = SyntaxStyle.fromStyles({})
  const [text, setText] = createSignal("intro\n\n```python\nprint(1)\n```")
  const app = await testRender(
    () => (
      <box width={80} height={24}>
        <markdown
          streaming={true}
          internalBlockMode="top-level"
          treeSitterClient={mock}
          syntaxStyle={style}
          content={text()}
        />
        <text>MARKER-BOTTOM</text>
      </box>
    ),
    { width: 80, height: 24, useThread: false },
  )
  try {
    await app.flush()
    setText("intro\n\n```python\nprint(1)\nprint(2) # v2\n```")
    await app.flush()
    await app.renderOnce()
    setText("intro\n\n```python\nprint(1)\nprint(2) # v2\nprint(3) # v3\n```")
    await app.flush()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("print(2)")
    expect(frame).toContain("print(3)")

    mock.resolveAllHighlightOnce()
    await app.flush()
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("print(3)")
    expect(app.captureCharFrame()).toContain("MARKER-BOTTOM")
  } finally {
    await mock.destroy().catch(() => {})
    app.renderer.destroy()
  }
}, 30000)
