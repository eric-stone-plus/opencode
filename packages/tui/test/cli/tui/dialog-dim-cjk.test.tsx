/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { StorageProvider } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Regression guard for the fork's translucent-fill patch in @opentui/core. The
// dialog backdrop dims the frame with RGBA(0, 0, 0, 150); the native fill used
// to replace every wide character it covered with a space, so CJK text under an
// open dialog turned blank. The patch blends the fill into the existing cells
// from JS instead, which must keep the characters while still dimming colors.

const directory = "/tmp/opencode/dialog-dim-cjk"
const location = { directory, project: { id: "dim", directory, canonical: directory } }

function Probe() {
  const dialog = useDialog()
  onMount(() => {
    dialog.replace(() => (
      <box width={40} backgroundColor="#101010">
        <text>usage window</text>
      </box>
    ))
  })
  return null
}

test("wide characters survive the translucent dialog backdrop", async () => {
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/location") return json(location)
    return undefined
  }, events)
  const temporary = await tmpdir()

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
                                    <box flexDirection="column">
                                      <text fg="#e6e6e6">Hello world ASCII line</text>
                                      <text fg="#e6e6e6">中文测试汉字若干</text>
                                      <text fg="#e6e6e6">Mixed 混排 English 中文</text>
                                    </box>
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
  await app.waitForFrame((frame) => frame.includes("usage window"))
  await app.renderOnce()

  const frame = app.captureCharFrame()
  expect(frame).toContain("Hello world ASCII line")
  expect(frame).toContain("中文测试汉字若干")
  expect(frame).toContain("Mixed 混排 English 中文")

  // The backdrop must still dim: 230 * (1 - 150/255) = 95 over the theme base background (10 -> 4).
  const dimmed = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("Hello"))
  expect(dimmed?.fg.toInts()).toEqual([95, 95, 95, 255])
  expect(dimmed?.bg.toInts()).toEqual([4, 4, 4, 255])

  app.renderer.destroy()
})
