import { expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { mountPrompt, wait } from "../../fixture/prompt"
import { directory, json } from "../../fixture/tui-sdk"

// Model selection is session-scoped: an explicit pick survives agent switches
// (Tab, follow, plan_exit); an agent's pinned model applies only while the
// session has no explicit choice.

const mimo = { providerID: "test", modelID: "mimo" }
const qwen = { providerID: "test", modelID: "qwen" }
const opus = { providerID: "test", modelID: "opus" }

function handle(request: Request) {
  const url = new URL(request.url)
  if (url.pathname === "/agent")
    return json([
      { name: "auto", mode: "primary", options: {}, permission: [] },
      { name: "build", mode: "primary", options: {}, permission: [] },
      { name: "plan", mode: "primary", options: {}, permission: [], model: opus },
    ])
  if (url.pathname === "/config/providers")
    return json({
      providers: [
        {
          id: "test",
          name: "Test",
          models: {
            mimo: { id: "mimo", name: "Mimo", variants: {} },
            qwen: { id: "qwen", name: "Qwen", variants: { high: {} } },
            opus: { id: "opus", name: "Opus", variants: { max: {} } },
          },
        },
      ],
      default: { test: "mimo" },
    })
  if (url.pathname === "/session" && request.method === "POST") return json({ id: "ses_new" })
  if (url.pathname === "/session/ses_new/message") return json({})
}

async function mount(state: string) {
  const tui = await mountPrompt(state, handle)
  await wait(() => tui.local.agent.list().length === 3)
  return tui
}

const current = (tui: Awaited<ReturnType<typeof mount>>) => {
  const model = tui.local.model.current()
  return model && { providerID: model.providerID, modelID: model.modelID }
}

test("an explicit pick survives Tab and direct agent switches in the session", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  expect(current(tui)).toEqual(mimo)
  tui.local.model.set(qwen)
  tui.local.agent.move(1)
  expect(tui.local.agent.current()?.name).toBe("build")
  expect(current(tui)).toEqual(qwen)
  // plan_exit / follow land via agent.set; plan's pin must not override.
  tui.local.agent.set("plan")
  expect(current(tui)).toEqual(qwen)
  tui.local.agent.set("auto")
  expect(current(tui)).toEqual(qwen)
})

test("an agent's pinned model applies only without an explicit pick", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  tui.local.agent.set("plan")
  expect(current(tui)).toEqual(opus)
  tui.local.agent.set("build")
  expect(current(tui)).toEqual(mimo)
})

test("a pick in one session does not leak into another", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  tui.local.model.set(qwen)
  tui.route.navigate({ type: "session", sessionID: "ses_b" })
  expect(current(tui)).toEqual(mimo)
  tui.local.agent.set("plan")
  expect(current(tui)).toEqual(opus)
  tui.route.navigate({ type: "session", sessionID: "ses_a" })
  expect(current(tui)).toEqual(qwen)
})

test("opening a session adopts its last user message's model as the session's choice", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  const user = (id: string, created: number, agent: string) => {
    const event = {
      type: "message.updated",
      properties: {
        sessionID: "ses_a",
        info: { id, sessionID: "ses_a", role: "user", time: { created }, agent, model: { ...qwen, variant: "high" } },
      },
    } as Event
    tui.events.emit({ directory, project: "proj_test", payload: event })
  }
  user("msg_1", 1, "build")
  await wait(() => current(tui)?.modelID === "qwen")
  expect(tui.local.agent.current()?.name).toBe("build")
  expect(tui.local.model.variant.current()).toBe("high")
  tui.local.agent.set("auto")
  expect(current(tui)).toEqual(qwen)
  // A server-side agent switch (plan_enter / plan_exit landing) is followed,
  // but the session's model stays.
  user("msg_2", 2, "plan")
  await wait(() => tui.local.agent.current()?.name === "plan")
  expect(current(tui)).toEqual(qwen)
})

test("a draft pick moves into the session it creates and the next draft starts fresh", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  tui.route.navigate({ type: "home" })
  await wait(() => tui.local.model.current()?.modelID === "mimo")
  tui.local.model.set(qwen)
  tui.prompt.set({ input: "hello", parts: [] })
  tui.prompt.submit()
  await wait(() => tui.route.data.type === "session" && tui.route.data.sessionID === "ses_new")
  expect(current(tui)).toEqual(qwen)
  const create = tui.requests.find(
    (request) => request.method === "POST" && new URL(request.url).pathname === "/session",
  )!
  expect((await create.json()).model).toMatchObject({ providerID: "test", id: "qwen" })
  tui.local.agent.set("plan")
  expect(current(tui)).toEqual(qwen)
  tui.route.navigate({ type: "home" })
  expect(current(tui)).toEqual(opus)
  tui.local.agent.set("build")
  expect(current(tui)).toEqual(mimo)
})

test("a session created without a pick keeps following agent pins", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  tui.route.navigate({ type: "home" })
  tui.prompt.set({ input: "hello", parts: [] })
  tui.prompt.submit()
  await wait(() => tui.route.data.type === "session" && tui.route.data.sessionID === "ses_new")
  expect(tui.local.model.known("ses_new")).toBe(true)
  expect(current(tui)).toEqual(mimo)
  tui.local.agent.set("plan")
  expect(current(tui)).toEqual(opus)
})

test("choosing a model drops a stored variant it does not offer", async () => {
  await using tmp = await tmpdir()
  using tui = await mount(tmp.path)
  tui.local.model.set(qwen)
  tui.local.model.variant.set("high")
  expect(tui.local.model.variant.current()).toBe("high")
  tui.local.model.set(opus)
  tui.local.model.variant.set("high")
  expect(tui.local.model.variant.selected()).toBe("high")
  tui.local.model.set(mimo)
  tui.local.model.set(opus)
  expect(tui.local.model.variant.selected()).toBeUndefined()
  tui.local.model.set(qwen)
  expect(tui.local.model.variant.selected()).toBe("high")
})
