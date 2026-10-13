/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogSessionList } from "../../../src/component/dialog-session-list"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { StorageProvider } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Deleting a session must leave the selection on the adjacent row with the row still
// visible: the first arrow key after a delete used to snap the list back to its top
// (the highlight scrolled out of view, directly under the search box), and only the
// second press restored it. The list needs to overflow the viewport for the defect
// to be reachable. Kitty trap: use the KeyCodes names (ARROW_DOWN, ARROW_UP), a bare
// "down" would be typed into the focused input.

const directory = "/tmp/opencode/session-list-delete"
const location = { directory, project: { id: "delete", directory, canonical: directory } }
// Selection background of the dark fixture theme.
const selectionBackground = [250, 178, 131, 255].join(",")

type FixtureSession = { id: string; title: string; updated: number }

// 14 sessions across three date categories, so the list is taller than the ~9-row viewport.
function sessions(): FixtureSession[] {
  const now = Date.now()
  return Array.from({ length: 14 }, (_, index) => ({
    id: `ses_del_m${String(index).padStart(2, "0")}`,
    title: `Many ${String(index).padStart(2, "0")}`,
    updated: now - (index < 7 ? index : 24 + index) * 3_600_000,
  }))
}

const info = (session: FixtureSession) => ({
  id: session.id,
  projectID: "delete",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: session.updated },
  title: session.title,
  location: { directory },
})

async function mountSessionList(config: { list: FixtureSession[]; current: string; deleteDelayMs?: number }) {
  const list = config.list
  const events = createEventStream()
  const completed: string[] = []
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") {
      const parentID = url.searchParams.get("parentID")
      if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
      return json({
        data: list.filter((session) => !completed.includes(session.id)).map(info),
        cursor: {},
      })
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
    if (one) {
      if (request.method === "DELETE") {
        if (config.deleteDelayMs) await Bun.sleep(config.deleteDelayMs)
        completed.push(one)
        return new Response(null, { status: 204 })
      }
      return json({ data: info(list.find((session) => session.id === one)!) })
    }
    return undefined
  }, events)
  const temporary = await tmpdir()

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    onMount(() => {
      data.session.remember(info(list.find((session) => session.id === config.current)!))
      route.navigate({ type: "session", sessionID: config.current })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={directory}>
                            <LocationProvider>
                              <ThemeProvider mode="dark" source={emptyThemeSource}>
                                <LocalProvider>
                                  <DialogProvider>
                                    <Probe />
                                  </DialogProvider>
                                </LocalProvider>
                              </ThemeProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, completed }
}

function scrollTopOf(app: Awaited<ReturnType<typeof mountSessionList>>["app"]) {
  const walk = (node: unknown): ScrollBoxRenderable | undefined => {
    if (node instanceof ScrollBoxRenderable) return node
    const children = (node as { getChildren?: () => unknown[] }).getChildren?.() ?? []
    for (const child of children) {
      const found = walk(child)
      if (found) return found
    }
    return undefined
  }
  return walk(app.renderer.root)?.scrollTop
}

// The text of the row carrying the selection background, or undefined when the
// highlighted row is scrolled out of view.
function highlightedText(app: Awaited<ReturnType<typeof mountSessionList>>["app"]) {
  for (const line of app.captureSpans().lines) {
    const hit = line.spans.find(
      (span) => span.bg.a > 0 && span.bg.toInts().join(",") === selectionBackground && span.text.trim().length > 0,
    )
    if (hit) return line.spans.map((span) => span.text).join("").trim()
  }
  return undefined
}

async function confirmAndDelete(
  app: Awaited<ReturnType<typeof mountSessionList>>["app"],
  completed: string[],
  session: FixtureSession,
  count: number,
) {
  app.mockInput.pressKey("d", { ctrl: true })
  await app.renderOnce()
  app.mockInput.pressKey("d", { ctrl: true })
  await app.waitFor(() => completed.length === count)
  await app.waitForFrame((frame) => !frame.includes("Press ctrl+d again to confirm") && !frame.includes(session.title))
}

test("deleting a session keeps the next arrow selection visible", async () => {
  const list = sessions()
  const { app, completed } = await mountSessionList({ current: "ses_del_m00", list })
  try {
    await app.waitForFrame((frame) => frame.includes("Many 00"))
    for (let index = 0; index < 10; index++) {
      app.mockInput.pressKey("ARROW_DOWN")
      await app.renderOnce()
    }
    expect(highlightedText(app)).toBe("Many 10")

    await confirmAndDelete(app, completed, list[10], 1)
    // The row that slid into the deleted row's place stays highlighted and visible.
    expect(highlightedText(app)).toBe("Many 11")

    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    expect(scrollTopOf(app)).toBeGreaterThan(0)
    expect(highlightedText(app)).toBe("Many 12")

    // Deleting again continues from the new position instead of resetting the list.
    await confirmAndDelete(app, completed, list[12], 2)
    expect(highlightedText(app)).toBe("Many 13")

    app.mockInput.pressKey("ARROW_UP")
    await app.renderOnce()
    expect(scrollTopOf(app)).toBeGreaterThan(0)
    expect(highlightedText(app)).toBe("Many 11")
  } finally {
    app.renderer.destroy()
  }
})

test("moving while a delete is in flight keeps the list in place", async () => {
  const list = sessions()
  const { app, completed } = await mountSessionList({ current: "ses_del_m00", list, deleteDelayMs: 400 })
  try {
    await app.waitForFrame((frame) => frame.includes("Many 00"))
    for (let index = 0; index < 10; index++) {
      app.mockInput.pressKey("ARROW_DOWN")
      await app.renderOnce()
    }

    app.mockInput.pressKey("d", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressKey("d", { ctrl: true })
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    // The delete has not resolved yet; the selection must already be on the next
    // row with the list still scrolled to it.
    expect(scrollTopOf(app)).toBeGreaterThan(0)
    expect(highlightedText(app)).toBe("Many 11")

    await app.waitFor(() => completed.length === 1)
    await app.waitForFrame((frame) => !frame.includes("Many 10"))
    expect(highlightedText(app)).toBe("Many 11")
    expect(scrollTopOf(app)).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})
