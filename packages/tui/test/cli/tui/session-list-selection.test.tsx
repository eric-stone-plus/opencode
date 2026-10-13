/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
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

// Arrow keys must move the session-list selection and Enter must open the selected one.
// When sending kitty-encoded keys through the harness, use the KeyCodes names (ARROW_DOWN,
// RETURN): a bare "down"/"return" is not in `KeyCodes`, so the harness falls back to typing
// the literal word into the focused input — which is a fixture trap, not app behaviour.
test("arrow keys move the session selection and Enter opens it", async () => {
  const directory = "/tmp/opencode/selection"
  const location = { directory, project: { id: "selection", directory, canonical: directory } }
  const sessions = [
    { id: "ses_sel_a", title: "Selection alpha", updated: 500 },
    { id: "ses_sel_b", title: "Selection beta", updated: 400 },
    { id: "ses_sel_c", title: "Selection gamma", updated: 300 },
    { id: "ses_sel_d", title: "Selection delta", updated: 200 },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") {
      const parentID = url.searchParams.get("parentID")
      if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
      return json({
        data: sessions.map((session) => ({
          id: session.id,
          projectID: "selection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: session.updated },
          title: session.title,
          location: { directory },
        })),
        cursor: {},
      })
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
    if (one)
      return json({
        data: {
          id: one,
          projectID: "selection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 100 },
          title: "Selection fixture",
          location: { directory },
        },
      })
    return undefined
  }, createEventStream())
  const temporary = await tmpdir()
  let route!: ReturnType<typeof useRoute>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    route = useRoute()
    onMount(() => {
      data.session.remember({
        id: "ses_sel_a",
        projectID: "selection",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 500 },
        title: "Selection alpha",
        location: { directory },
      })
      route.navigate({ type: "session", sessionID: "ses_sel_a" })
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

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Selection alpha") && frame.includes("Selection gamma"))
    // The current session gets the initial selection at the top of the list.
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    // Back up one row so the selection is deterministically on "Selection beta".
    app.mockInput.pressKey("ARROW_UP")
    await app.renderOnce()
    app.mockInput.pressKey("RETURN")
    await app.waitFor(() => route.data.type === "session" && route.data.sessionID !== "ses_sel_a")
    expect(route.data.type).toBe("session")
    if (route.data.type !== "session") throw new Error("unreachable")
    expect(route.data.sessionID).toBe("ses_sel_b")
  } finally {
    app.renderer.destroy()
  }
})
