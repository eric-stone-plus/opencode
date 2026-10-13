/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { ClientProvider, useClient } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { LocationProvider } from "../../src/context/location"
import { RouteProvider, useRoute } from "../../src/context/route"
import { createSessionViewed } from "../../src/context/session-viewed"
import { TuiAppProvider } from "../../src/context/runtime"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 2_000, label = "condition") {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

// Coverage ported from the deleted session-tabs suite: the acknowledgement contract is
// server-facing (other clients read what this TUI has seen) and must outlive the strip.
async function renderSessionViewed(state: string, options?: { viewFailures?: number }) {
  const views: string[] = []
  const viewWatermarks: number[] = []
  const calls = createFetch(async (url, request) => {
    const viewed = url.pathname.match(/^\/api\/session\/([^/]+)\/view$/)?.[1]
    if (viewed && request.method === "POST") {
      views.push(viewed)
      const payload: unknown = await request.json()
      if (typeof payload !== "object" || payload === null || !("idle" in payload) || typeof payload.idle !== "number")
        throw new Error("Expected an idle watermark")
      viewWatermarks.push(payload.idle)
      if (views.length <= (options?.viewFailures ?? 0)) return new Response(null, { status: 503 })
      return new Response(null, { status: 204 })
    }
    const sessionID = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
    if (!sessionID) return undefined
    return json({
      data: {
        id: sessionID,
        title: "Fresh session",
        projectID: "project",
        location: { directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0, idle: 2 },
      },
    })
  }, createEventStream())

  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>
  function Probe() {
    const renderer = useRenderer()
    const route = useRoute()
    data = useData()
    client = useClient()
    createSessionViewed({ renderer, client, data, route })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <RouteProvider initialRoute={{ type: "session", sessionID: "first" }}>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider directory={directory}>
                <LocationProvider>
                  <Probe />
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </RouteProvider>
        </ConfigProvider>
      </TuiAppProvider>
    </TestTuiContexts>
  ))

  await wait(() => client.connection.status() === "connected")
  await data.session.sync("first")
  return {
    views,
    viewWatermarks,
    focus: () => app.renderer.emit("focus"),
    blur: () => app.renderer.emit("blur"),
    destroy: () => app.renderer.destroy(),
  }
}

test("acknowledges an unread session once it is focused", async () => {
  await using state = await tmpdir()
  const setup = await renderSessionViewed(state.path)
  try {
    setup.focus()
    await wait(() => setup.views.includes("first"))
    expect(setup.viewWatermarks).toEqual([2])
  } finally {
    setup.destroy()
  }
})

test("does not acknowledge an unread session until focus is confirmed", async () => {
  await using state = await tmpdir()
  const setup = await renderSessionViewed(state.path)
  try {
    setup.blur()
    await Bun.sleep(20)
    expect(setup.views).toEqual([])

    setup.focus()
    await wait(() => setup.views.includes("first"))
  } finally {
    setup.destroy()
  }
})

test("retries a failed view acknowledgement", async () => {
  await using state = await tmpdir()
  const setup = await renderSessionViewed(state.path, { viewFailures: 1 })
  try {
    setup.focus()
    await wait(() => setup.views.length === 2)
    expect(setup.views).toEqual(["first", "first"])
    expect(setup.viewWatermarks).toEqual([2, 2])
  } finally {
    setup.destroy()
  }
})
