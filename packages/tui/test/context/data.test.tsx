/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { SDKProvider } from "../../src/context/sdk"
import { DATA_MESSAGE_MAX, DataProvider, useData } from "../../src/context/data"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"

function prompted(sessionID: string, index: number): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${sessionID}_${index}`,
      type: "session.next.prompted",
      properties: {
        sessionID,
        messageID: `msg_${index}`,
        timestamp: index,
        prompt: { text: `prompt ${index}`, files: [], agents: [] },
      },
    } as unknown as GlobalEvent["payload"],
  }
}

async function mount() {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/message") && url.pathname.includes("ses_loaded")) return json({ data: [] })
    return undefined
  })
  let data!: ReturnType<typeof useData>
  let done!: () => void
  const ready = new Promise<void>((resolve) => (done = resolve))
  function Probe() {
    const ctx = useData()
    onMount(() => {
      data = ctx
      done()
    })
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))
  await ready
  return { app, emit: events.emit, data }
}

test("v2 session events are not accumulated for sessions nothing loaded", async () => {
  const { app, emit, data } = await mount()
  try {
    await Bun.sleep(20)
    for (let index = 0; index < 5; index++) emit(prompted("ses_unloaded", index))
    await Bun.sleep(50)
    expect(data.session.message.list("ses_unloaded")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("loaded sessions receive live events, capped newest first", async () => {
  const { app, emit, data } = await mount()
  try {
    await Bun.sleep(20)
    await data.session.message.refresh("ses_loaded")
    for (let index = 0; index < DATA_MESSAGE_MAX + 10; index++) emit(prompted("ses_loaded", index))
    const latest = `msg_${DATA_MESSAGE_MAX + 9}`
    const deadline = Date.now() + 2000
    while (data.session.message.list("ses_loaded")?.[0]?.id !== latest && Date.now() < deadline) await Bun.sleep(10)
    const list = data.session.message.list("ses_loaded")!
    expect(list.length).toBe(DATA_MESSAGE_MAX)
    expect(list[0].id).toBe(latest)
  } finally {
    app.renderer.destroy()
  }
})
