import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { mountPrompt, wait } from "../../fixture/prompt"
import { json } from "../../fixture/tui-sdk"

type Tui = Awaited<ReturnType<typeof mountPrompt>>

// Typing a local slash command with a trailing space hides the slash
// autocomplete, so the submit path intercepts it. These tests cover that
// interception: the composer is cleared first and the command runs only after
// submit has settled, matching the autocomplete path.

function probe(tui: Tui, run: () => boolean | void) {
  return tui.keymap.registerLayer({
    commands: [{ name: "test.probe", title: "Probe", namespace: "palette", slashName: "probe", run }],
  })
}

test("a local slash command runs after the composer is cleared", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined)
  const seen: string[] = []
  const off = probe(tui, () => {
    seen.push(tui.prompt.current.input)
  })
  tui.prompt.set({ input: "/probe ", parts: [] })
  tui.prompt.submit()
  await wait(() => seen.length === 1)
  expect(seen).toEqual([""])
  expect(tui.prompt.current.input).toBe("")
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
  off()
})

test("a local slash command that sets the prompt keeps its text (undo)", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined)
  let ran = false
  const off = probe(tui, () => {
    tui.prompt.set({ input: "restored by undo", parts: [] })
    ran = true
  })
  tui.prompt.set({ input: "/probe ", parts: [] })
  tui.prompt.submit()
  await wait(() => ran)
  await Bun.sleep(20)
  expect(tui.prompt.current.input).toBe("restored by undo")
  off()
})

test("a local slash command that destroys the renderer (exit) does not throw", async () => {
  await using tmp = await tmpdir()
  const tui = await mountPrompt(tmp.path, () => undefined)
  const errors: unknown[] = []
  const onError = (error: unknown) => errors.push(error)
  process.on("unhandledRejection", onError)
  process.on("uncaughtException", onError)
  try {
    probe(tui, () => {
      tui.app.renderer.destroy()
    })
    tui.prompt.set({ input: "/probe ", parts: [] })
    tui.prompt.submit()
    await wait(() => tui.app.renderer.isDestroyed)
    await Bun.sleep(20)
    expect(errors).toEqual([])
  } finally {
    process.off("unhandledRejection", onError)
    process.off("uncaughtException", onError)
    if (!tui.app.renderer.isDestroyed) tui[Symbol.dispose]()
  }
})

test("/withdraw typed with a trailing space withdraws the queued message", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw"))
      return json({
        info: { id: "msg_queued", role: "user", sessionID: "ses_a" },
        parts: [{ id: "prt_text", messageID: "msg_queued", sessionID: "ses_a", type: "text", text: "queued" }],
      })
  })
  tui.prompt.set({ input: "/withdraw ", parts: [] })
  tui.prompt.submit()
  await wait(() => tui.prompt.current.input === "queued")
  expect(tui.requests.filter((request) => request.url.includes("/withdraw"))).toHaveLength(1)
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
})

test("a local slash command that does not run restores the input", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, () => undefined)
  let ran = false
  const off = probe(tui, () => {
    ran = true
    return false
  })
  tui.prompt.set({ input: "/probe ", parts: [] })
  tui.prompt.submit()
  await wait(() => ran)
  await wait(() => tui.prompt.current.input === "/probe ")
  expect(tui.toast.currentToast?.message).toBe("/probe is not available here")
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
  off()
})

test("shell mode input is never intercepted as a local slash command", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/shell")) return json({})
  })
  let ran = false
  const off = probe(tui, () => {
    ran = true
  })
  tui.prompt.focus()
  tui.app.mockInput.typeText("!")
  await Bun.sleep(10)
  tui.app.mockInput.typeText("/probe ")
  await wait(() => tui.prompt.current.input === "/probe ")
  tui.prompt.submit()
  await wait(() => tui.requests.some((request) => request.url.includes("/shell")))
  await Bun.sleep(20)
  expect(ran).toBe(false)
  const sent = tui.requests.find((request) => request.url.includes("/shell"))!
  expect((await sent.json()).command).toBe("/probe ")
  off()
})
