/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { mount, wait } from "./sync-fixture"

const sessionID = "ses_delta_field"
const messageID = "msg_delta_field"
const directory = "/tmp/opencode/packages/tui"

const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: directory, root: directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function textPart(id: string, text: string) {
  return { id, sessionID, messageID, type: "text" as const, text }
}

// Regression: sync.tsx applied `part[field] += delta` for an unvalidated
// field name. A hostile/buggy sender could therefore mutate part.id (breaking
// the sorted-by-id search invariant) or stringify part.state.
test("message.part.delta with a non-text field does not corrupt the part", async () => {
  const { app, emit, sync } = await mount(undefined)
  try {
    emit(global({ id: "e1", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "e_part",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: textPart("prt_abc", "hello") },
      }),
    )
    await wait(() => (sync.data.part[messageID]?.length ?? 0) === 1)

    emit(
      global({
        id: "e_delta_id",
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID,
          partID: "prt_abc",
          field: "id",
          delta: "_appended",
        },
      }),
    )
    await Bun.sleep(50)
    const part: any = sync.data.part[messageID]?.[0]
    expect(part?.id).toBe("prt_abc")
  } finally {
    app.renderer.destroy()
  }
})

test("message.part.delta with field=state keeps the state an object", async () => {
  const { app, emit, sync } = await mount(undefined)
  try {
    emit(global({ id: "e1", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "e_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: {
            id: "prt_tool1",
            sessionID,
            messageID,
            type: "tool" as const,
            callID: "call_1",
            tool: "bash",
            state: { status: "running" as const, input: {}, title: "t", time: { start: 1 } },
          },
        },
      }),
    )
    await wait(() => (sync.data.part[messageID]?.length ?? 0) === 1)

    emit(
      global({
        id: "e_delta_state",
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID,
          partID: "prt_tool1",
          field: "state",
          delta: "GARBAGE",
        },
      }),
    )
    await Bun.sleep(50)
    const part: any = sync.data.part[messageID]?.[0]
    expect(typeof part?.state).toBe("object")
  } finally {
    app.renderer.destroy()
  }
})

test("message.part.delta with field=text still streams", async () => {
  const { app, emit, sync } = await mount(undefined)
  try {
    emit(global({ id: "e1", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "e_part",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: textPart("prt_txt", "") },
      }),
    )
    await wait(() => (sync.data.part[messageID]?.length ?? 0) === 1)

    for (const [i, delta] of ["Hello", ", ", "world"].entries()) {
      emit(
        global({
          id: `e_delta_${i}`,
          type: "message.part.delta",
          properties: { sessionID, messageID, partID: "prt_txt", field: "text", delta },
        }),
      )
    }
    await Bun.sleep(50)
    const part: any = sync.data.part[messageID]?.[0]
    expect(part?.text).toBe("Hello, world")
  } finally {
    app.renderer.destroy()
  }
})
