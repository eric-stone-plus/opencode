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

// The withdrawn content must survive a composer that went away or changed
// session between the request and its answer: it is stashed rather than
// written into whatever the composer now shows.
test.each(["session", "unmount"])("Esc withdrawal survives a composer %s", async (change) => {
  await using tmp = await tmpdir()
  const response = pendingResponse()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return response.promise
  })
  tui.keymap.dispatchCommand("session.interrupt")
  await wait(() => tui.requests.some((request) => request.url.includes("/withdraw")))
  if (change === "session") tui.route.navigate({ type: "session", sessionID: "ses_b" })
  if (change === "unmount") tui.setVisible(false)
  response.resolve(withdrawn())
  await wait(() => tui.stash.list().length === 1)
  expect(tui.stash.list()[0].input).toBe("queued @explore")
  if (change === "session") expect(tui.prompt.current.input).toBe("")
})

test("Esc withdrawal restores agent parts without persisted IDs", async () => {
  await using tmp = await tmpdir()
  using tui = await mountPrompt(tmp.path, (request) => {
    if (new URL(request.url).pathname.endsWith("/withdraw")) return withdrawn()
  })
  tui.keymap.dispatchCommand("session.interrupt")
  await wait(() => tui.prompt.current.input === "queued @explore")
  expect(tui.requests.filter((request) => request.url.includes("/withdraw"))).toHaveLength(1)
  expect(tui.prompt.current.parts).toEqual([
    { type: "agent", name: "explore", source: { start: 7, end: 15, value: "@explore" } },
  ])
})
