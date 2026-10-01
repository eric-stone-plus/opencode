/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import { SESSION_CACHE_MAX } from "../../../../src/context/sync-cache"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function session(id: string, parentID?: string) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    title: id,
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
    ...(parentID ? { parentID } : {}),
  }
}

function assistant(sessionID: string, id = `msg_${sessionID}`) {
  return {
    id,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: "msg_user",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
  }
}

function seed(emit: (event: GlobalEvent) => void, sessionID: string) {
  const info = assistant(sessionID)
  emit(global({ id: `evt_m_${sessionID}`, type: "message.updated", properties: { sessionID, info } }))
  emit(
    global({
      id: `evt_p_${sessionID}`,
      type: "message.part.updated",
      properties: {
        sessionID,
        time: 2,
        part: { id: `prt_${sessionID}`, sessionID, messageID: info.id, type: "text", text: "hello" },
      },
    }),
  )
  emit(global({ id: `evt_t_${sessionID}`, type: "todo.updated", properties: { sessionID, todos: [] } }))
}

test("part events for a message that is not resident are dropped instead of stored as orphans", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_orphan",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_x",
          time: 1,
          part: { id: "prt_orphan", sessionID: "ses_x", messageID: "msg_missing", type: "text", text: "lost" },
        },
      }),
    )
    seed(emit, "ses_x")
    await wait(() => sync.data.part["msg_ses_x"]?.length === 1)
    expect(sync.data.part["msg_missing"]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("session.deleted releases the session's messages, parts and todo", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    emit(global({ id: "evt_s", type: "session.updated", properties: { sessionID: "ses_d", info: session("ses_d") } }))
    seed(emit, "ses_d")
    await wait(() => sync.data.part["msg_ses_d"]?.length === 1 && sync.data.todo["ses_d"] !== undefined)
    emit(global({ id: "evt_del", type: "session.deleted", properties: { sessionID: "ses_d", info: session("ses_d") } }))
    await wait(() => sync.data.message["ses_d"] === undefined)
    expect(sync.data.part["msg_ses_d"]).toBeUndefined()
    expect(sync.data.todo["ses_d"]).toBeUndefined()
    expect(sync.session.get("ses_d")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("least recently used non-active sessions are evicted; route session and its running children stay", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path, { type: "session", sessionID: "ses_route" })

  try {
    for (const info of [session("ses_route"), session("ses_child", "ses_route")])
      emit(global({ id: `evt_s_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } }))
    emit(
      global({
        id: "evt_busy",
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "busy" } },
      }),
    )
    seed(emit, "ses_route")
    seed(emit, "ses_child")
    const others = Array.from({ length: SESSION_CACHE_MAX + 2 }, (_, index) => `ses_other_${index}`)
    for (const id of others) seed(emit, id)
    await wait(() => sync.data.part[`msg_${others.at(-1)}`]?.length === 1)

    const evicted = others.slice(0, 2)
    for (const id of evicted) {
      expect(sync.data.message[id]).toBeUndefined()
      expect(sync.data.part[`msg_${id}`]).toBeUndefined()
      expect(sync.data.todo[id]).toBeUndefined()
    }
    for (const id of others.slice(2)) expect(sync.data.message[id]?.length).toBe(1)
    for (const id of ["ses_route", "ses_child"]) {
      expect(sync.data.message[id]?.length).toBe(1)
      expect(sync.data.part[`msg_${id}`]?.length).toBe(1)
    }
  } finally {
    app.renderer.destroy()
  }
})
