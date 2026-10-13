import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }

const sessionInfo = (id: string) => ({
  id,
  title: "Esc withdraw fixture",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
})

const userMessage = (id: string, text: string, created: number) => ({ id, type: "user" as const, text, time: { created } })
const assistantMessage = (id: string, content: unknown[], created: number) => ({
  id,
  type: "assistant" as const,
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: { created },
  content,
})

const started = (sessionID: string) => ({
  id: "evt_started",
  created: 8,
  type: "session.execution.started" as const,
  durable: { aggregateID: sessionID, seq: 8, version: 1 as const },
  data: { sessionID },
})

const cancelled = (sessionID: string, inboxID: string) => ({
  id: "evt_cancelled",
  created: 9,
  type: "session.inbox.cancelled" as const,
  durable: { aggregateID: sessionID, seq: 9, version: 1 as const },
  data: { sessionID, inboxID },
})

type Recorders = {
  info: ReturnType<typeof sessionInfo>
  messages?: unknown[]
  inbox?: unknown[]
  deleted?: string[]
  interrupts?: (string | null)[]
  staged?: string[]
}

function handlers(input: Recorders): FetchHandler {
  const id = input.info.id
  return (url, request) => {
    const path = url.pathname
    if (path === "/api/location") return json(location)
    if (path === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (path === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    if (path === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
    if (path === "/api/session") return json({ data: [input.info], cursor: {} })
    if (path === "/api/session/active") return json({ data: { [id]: { type: "running" } } })
    if (path === `/api/session/${id}`) return json({ data: input.info })
    if (path === `/api/session/${id}/message`) return json({ data: input.messages ?? [], cursor: {} })
    if (path === `/api/session/${id}/inbox` && request.method === "GET") return json({ data: input.inbox ?? [] })
    if (path === `/api/session/${id}/permission`) return json({ data: [] })
    if (path === `/api/session/${id}/interrupt` && request.method === "POST") {
      input.interrupts?.push(url.searchParams.get("resume"))
      return json({ interrupted: true })
    }
    if (path === `/api/session/${id}/revert/stage` && request.method === "POST") {
      input.staged?.push(path)
      return json({ data: { messageID: id } })
    }
    if (path === `/api/experimental/session/${id}/wait` && request.method === "POST")
      return new Response(null, { status: 204 })
    if (path.startsWith(`/api/session/${id}/inbox/`) && request.method === "DELETE") {
      input.deleted?.push(path)
      return new Response(null, { status: 204 })
    }
    return undefined
  }
}

const count = (frame: string, text: string) => frame.split(text).length - 1

test("the first escape withdraws a pending prompt, the second interrupts", async () => {
  await using state = await tmpdir()
  const info = sessionInfo("ses_withdraw")
  const deleted: string[] = []
  const interrupts: (string | null)[] = []
  const pending = {
    id: "msg_queued",
    sessionID: info.id,
    time: { created: 3 },
    type: "user",
    delivery: "steer",
    payload: { text: "withdraw me" },
  }
  await using setup = await createAppFixture({
    width: 140,
    height: 30,
    state: state.path,
    config: { animations: false, session: { sidebar: "hide" } },
    args: { sessionID: info.id },
    fetch: handlers({
      info,
      messages: [userMessage("msg_queued", "withdraw me", 3)],
      inbox: [pending],
      deleted,
      interrupts,
    }),
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
  setup.events.emit(started(info.id))
  await setup.waitForFrame((frame) => frame.includes("esc interrupt"))
  await setup.waitForFrame((frame) => frame.includes("withdraw me"))
  expect(count(setup.captureCharFrame(), "withdraw me")).toBe(1)

  setup.mockInput.pressEscape()
  await setup.waitFor(() => deleted.length === 1)
  await setup.waitForFrame((frame) => count(frame, "withdraw me") === 2)

  setup.mockInput.pressEscape()
  await setup.waitFor(() => interrupts.length === 1)
  expect(interrupts[0]).toBe("true")

  setup.events.emit(cancelled(info.id, "msg_queued"))
  await setup.waitForFrame((frame) => count(frame, "withdraw me") === 1)
})

test("a composer draft is never clobbered by the escape withdraw", async () => {
  await using state = await tmpdir()
  const info = sessionInfo("ses_draft")
  const deleted: string[] = []
  const interrupts: (string | null)[] = []
  const pending = {
    id: "msg_queued",
    sessionID: info.id,
    time: { created: 3 },
    type: "user",
    delivery: "steer",
    payload: { text: "withdraw me" },
  }
  await using setup = await createAppFixture({
    width: 140,
    height: 30,
    state: state.path,
    config: { animations: false, session: { sidebar: "hide" } },
    args: { sessionID: info.id },
    fetch: handlers({ info, messages: [userMessage("msg_queued", "withdraw me", 3)], inbox: [pending], deleted, interrupts }),
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
  setup.events.emit(started(info.id))
  await setup.waitForFrame((frame) => frame.includes("esc interrupt"))
  await setup.mockInput.typeText("keep my draft")
  await setup.waitForFrame((frame) => frame.includes("keep my draft"))

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("esc again to interrupt"))
  expect(deleted.length).toBe(0)
  expect(interrupts.length).toBe(0)

  setup.mockInput.pressEscape()
  await setup.waitFor(() => interrupts.length === 1)
  expect(deleted.length).toBe(0)
  expect(setup.captureCharFrame()).toContain("keep my draft")
})

test("an escape retracts a started reply that rendered no output", async () => {
  await using state = await tmpdir()
  const info = sessionInfo("ses_started")
  const interrupts: (string | null)[] = []
  const staged: string[] = []
  await using setup = await createAppFixture({
    width: 140,
    height: 30,
    state: state.path,
    config: { animations: false, session: { sidebar: "hide" } },
    args: { sessionID: info.id },
    fetch: handlers({
      info,
      messages: [assistantMessage("msg_reply", [], 4), userMessage("msg_started", "bring me back", 3)],
      interrupts,
      staged,
    }),
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
  setup.events.emit(started(info.id))
  await setup.waitForFrame((frame) => frame.includes("esc interrupt"))
  await setup.waitForFrame((frame) => frame.includes("bring me back"))

  setup.mockInput.pressEscape()
  await setup.waitFor(() => staged.length === 1)
  expect(interrupts.length).toBe(1)
  expect(interrupts[0]).toBe(null)
  await setup.waitForFrame((frame) => count(frame, "bring me back") === 2)
})

test("an escape leaves an answered prompt to /undo", async () => {
  await using state = await tmpdir()
  const info = sessionInfo("ses_answered")
  const deleted: string[] = []
  const interrupts: (string | null)[] = []
  const staged: string[] = []
  await using setup = await createAppFixture({
    width: 140,
    height: 30,
    state: state.path,
    config: { animations: false, session: { sidebar: "hide" } },
    args: { sessionID: info.id },
    fetch: handlers({
      info,
      messages: [
        assistantMessage("msg_answer", [{ type: "text", text: "here is the answer" }], 4),
        userMessage("msg_answered", "already answered", 3),
      ],
      deleted,
      interrupts,
      staged,
    }),
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
  setup.events.emit(started(info.id))
  await setup.waitForFrame((frame) => frame.includes("esc interrupt"))
  await setup.waitForFrame((frame) => frame.includes("already answered"))

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("esc again to interrupt"))
  expect(deleted.length).toBe(0)
  expect(staged.length).toBe(0)
  expect(interrupts.length).toBe(0)
  expect(setup.captureCharFrame()).toContain("already answered")
})
