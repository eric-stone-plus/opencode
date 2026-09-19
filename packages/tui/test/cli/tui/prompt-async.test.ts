import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { mountPrompt, pendingResponse, wait } from "../../fixture/prompt"
import { json } from "../../fixture/tui-sdk"

function withdrawn() {
  return json({
    info: { id: "msg_queued", role: "user", sessionID: "ses_a" },
    parts: [
      { id: "prt_text", messageID: "msg_queued", sessionID: "ses_a", type: "text", text: "queued @explore" },
      {
        id: "prt_agent",
        messageID: "msg_queued",
        sessionID: "ses_a",
        type: "agent",
        name: "explore",
        source: { start: 7, end: 15, value: "@explore" },
      },
    ],
  })
}

test("Esc withdrawal preserves text typed while the request is pending", async () => {
  await using tmp = await tmpdir()
  const response = pendingResponse()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return response.promise
  })
  tui.keymap.dispatchCommand("session.interrupt")
  await wait(() => tui.requests.some((request) => request.url.includes("/withdraw")))
  tui.app.mockInput.typeText("new draft")
  response.resolve(withdrawn())
  await wait(() => tui.stash.list().length === 1)
  expect(tui.prompt.current.input).toBe("new draft")
  expect(tui.stash.list()[0].input).toBe("queued @explore")
})

test.each(["session", "unmount"])("explicit withdrawal survives a composer %s", async (change) => {
  await using tmp = await tmpdir()
  const response = pendingResponse()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return response.promise
  })
  tui.keymap.dispatchCommand("session.queued_prompts")
  await wait(() => tui.requests.some((request) => request.url.includes("/withdraw")))
  if (change === "session") tui.route.navigate({ type: "session", sessionID: "ses_b" })
  if (change === "unmount") tui.setVisible(false)
  response.resolve(withdrawn())
  await wait(() => tui.stash.list().length === 1)
  expect(tui.stash.list()[0].input).toBe("queued @explore")
  if (change === "session") expect(tui.prompt.current.input).toBe("")
})

test("explicit withdrawal saves an existing draft before replacing it", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return withdrawn()
  })
  tui.prompt.set({ input: "existing draft", parts: [] })
  tui.keymap.dispatchCommand("session.queued_prompts")
  await wait(() => tui.prompt.current.input === "queued @explore")
  expect(tui.stash.list()[0].input).toBe("existing draft")
})

test("withdrawal is serialized and restores agent parts without persisted IDs", async () => {
  await using tmp = await tmpdir()
  const response = pendingResponse()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return response.promise
  })
  tui.keymap.dispatchCommand("session.queued_prompts")
  tui.keymap.dispatchCommand("session.queued_prompts")
  await wait(() => tui.requests.some((request) => request.url.includes("/withdraw")))
  response.resolve(withdrawn())
  await wait(() => tui.prompt.current.input === "queued @explore")
  expect(tui.requests.filter((request) => request.url.includes("/withdraw"))).toHaveLength(1)
  expect(tui.prompt.current.parts).toEqual([
    { type: "agent", name: "explore", source: { start: 7, end: 15, value: "@explore" } },
  ])
})

test("force send preserves the draft and reports an unsuccessful abort", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname.endsWith("/abort")) return json({ message: "cannot interrupt" }, { status: 500 })
    if (pathname.endsWith("/message")) return json({})
  })
  tui.prompt.set({ input: "new instruction", parts: [] })
  tui.keymap.dispatchCommand("session.force_send")
  await wait(() => tui.toast.currentToast?.title === "Failed to interrupt session")
  expect(tui.prompt.current.input).toBe("new instruction")
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
})

test("force send serializes abort and submission with Enter and repeated Ctrl+S", async () => {
  await using tmp = await tmpdir()
  const response = pendingResponse()
  using tui = await mountPrompt(tmp.path, (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname.endsWith("/abort")) return response.promise
    if (pathname.endsWith("/message")) return json({})
  })
  tui.prompt.set({ input: "new instruction", parts: [] })
  tui.keymap.dispatchCommand("session.force_send")
  tui.keymap.dispatchCommand("session.force_send")
  tui.prompt.submit()
  await wait(() => tui.requests.some((request) => request.url.includes("/abort")))
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
  response.resolve(json(true))
  await wait(() => tui.requests.some((request) => request.url.includes("/message")))
  expect(tui.requests.filter((request) => request.url.includes("/abort"))).toHaveLength(1)
  expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(1)
  const sent = tui.requests.find((request) => request.url.includes("/message"))!
  expect(new URL(sent.url).pathname).toBe("/session/ses_a/message")
  expect((await sent.json()).parts).toEqual([{ type: "text", text: "new instruction" }])
})

test.each(["draft", "session", "unmount"])(
  "force send does not submit after a pending abort and %s change",
  async (change) => {
    await using tmp = await tmpdir()
    const response = pendingResponse()
    using tui = await mountPrompt(tmp.path, (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/abort")) return response.promise
      if (pathname.endsWith("/message")) return json({})
    })
    tui.prompt.set({ input: "old instruction", parts: [] })
    tui.keymap.dispatchCommand("session.force_send")
    await wait(() => tui.requests.some((request) => request.url.includes("/abort")))
    if (change === "draft") tui.prompt.set({ input: "new draft", parts: [] })
    if (change === "session") tui.route.navigate({ type: "session", sessionID: "ses_b" })
    if (change === "unmount") {
      tui.prompt.reset()
      tui.setVisible(false)
    }
    response.resolve(json(true))
    await Bun.sleep(20)
    if (change !== "unmount")
      expect(tui.prompt.current.input).toBe(change === "draft" ? "new draft" : "old instruction")
    expect(tui.requests.filter((request) => request.url.includes("/message"))).toHaveLength(0)
  },
)

test("force send does not interrupt when the composer is disabled", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/abort")) return json(true)
  })
  tui.prompt.set({ input: "new instruction", parts: [] })
  tui.setDisabled(true)
  tui.keymap.dispatchCommand("session.force_send")
  await Bun.sleep(20)
  expect(tui.requests.filter((request) => request.url.includes("/abort"))).toHaveLength(0)
  expect(tui.prompt.current.input).toBe("new instruction")
})
