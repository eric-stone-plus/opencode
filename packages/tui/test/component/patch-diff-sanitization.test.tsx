/** @jsxImportSource @opentui/solid */
// A diff carries file content, so it carries whatever bytes that file holds. The renderer does not
// filter them, and every diff surface in the TUI (session transcript, permission dialog, mini
// scrollback, diff viewer) mounts this component, which makes it the seam.
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { PatchDiff } from "../../src/component/patch-diff"

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"
const FRAME_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

test("patch diff drops control bytes from the file content", async () => {
  const diff = [
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,2 +1,2 @@",
    " unchanged",
    `+ADDED-${CLEAR}-line`,
    `-REMOVED-${OSC}-line`,
  ].join("\n")

  const app = await testRender(() => <PatchDiff diff={diff} hunkFg="#888888" lineNumberBg="#222222" />, {
    width: 80,
    height: 12,
    kittyKeyboard: true,
  })
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("ADDED-"))
    const frame = app.captureCharFrame()
    expect(frame.includes("ADDED-")).toBe(true)
    expect(frame).not.toMatch(FRAME_CONTROL)
  } finally {
    app.renderer.destroy()
  }
})
