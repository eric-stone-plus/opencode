/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ErrorComponent } from "../../src/component/error-component"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"

async function render(write: (text: string) => Promise<void>) {
  const app = await testRender(
    () => (
      <ExitProvider exit={() => {}}>
        <ClipboardProvider value={{ write }}>
          <ErrorComponent error={new Error("boom")} reset={() => {}} />
        </ClipboardProvider>
      </ExitProvider>
    ),
    { width: 100, height: 30 },
  )
  return app
}

async function frameAfterCopy(write: (text: string) => Promise<void>) {
  const app = await render(write)
  try {
    app.mockInput.pressKey("c")
    await Bun.sleep(20)
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("crash screen reports a failed report copy", async () => {
  const frame = await frameAfterCopy(async () => {
    throw new Error("Clipboard unavailable")
  })
  expect(frame).toContain("Copy failed")
  expect(frame).toContain("Could not copy to the clipboard")
  expect(frame).not.toContain("Copied")
})

test("crash screen confirms a successful report copy", async () => {
  const frame = await frameAfterCopy(async () => {})
  expect(frame).toContain("✓ Copied")
  expect(frame).toContain("Report copied")
})
