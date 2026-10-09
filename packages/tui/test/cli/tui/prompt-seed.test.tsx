/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { mountPrompt, wait } from "../../fixture/prompt"

// The fork prompt and --prompt seed the composer from the ref callback during
// render; the draft restore runs on mount afterwards and must not clear it.
test("a prompt seeded during mount is not cleared by the draft restore", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined, { seed: { input: "fork seed", parts: [] } })
  expect(tui.prompt.current.input).toBe("fork seed")
})

// A fork of a message whose text was synthetic carries only parts.
test("a parts-only seed survives the draft restore", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined, {
    seed: {
      input: "",
      parts: [{ type: "text", text: "part", source: { text: { start: 0, end: 4, value: "part" } } }],
    },
  })
  expect(tui.prompt.current.parts.length).toBeGreaterThan(0)
})

// The fixture changes the sessionID prop in place (no remount), the same way
// the plugin API does. A saved draft must survive that: ref.reset() merges
// into the live store node, so the draft map must hold a copy.
test("a draft survives an in-place session switch and return", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined)
  tui.app.mockInput.typeText("draft a")
  await wait(() => tui.prompt.current.input === "draft a")

  tui.route.navigate({ type: "session", sessionID: "ses_b" })
  await wait(() => tui.prompt.current.input === "")

  tui.route.navigate({ type: "session", sessionID: "ses_a" })
  await wait(() => tui.prompt.current.input === "draft a")
  expect(tui.prompt.current.input).toBe("draft a")
})
