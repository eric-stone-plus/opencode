/** @jsxImportSource @opentui/solid */
// Dialog titles, messages and the error-details path can carry text chosen by a plugin, a server
// error, or a repository path. The renderer does not filter control bytes, so each of these sinks
// must sanitize before the byte reaches the grid. This suite renders the real dialogs with CLEAR
// and OSC payloads and asserts the frame carries no control byte.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount, type JSX } from "solid-js"
import { DialogErrorDetails } from "../../src/component/dialog-error-details"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogAlert } from "../../src/ui/dialog-alert"
import { DialogConfirm } from "../../src/ui/dialog-confirm"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"
// Tab and newline are the only control bytes a rendered frame may carry.
const FRAME_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

async function renderDialog(element: () => JSX.Element, marker: string) {
  await using temporary = await tmpdir()
  const api = createApi(createFetch(() => undefined, createEventStream()).fetch)

  function OpenDialog() {
    const dialog = useDialog()
    onMount(() => dialog.replace(element))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={temporary.path}
        paths={{ state: temporary.path }}
        clipboard={{ read: async () => undefined, write: async () => undefined }}
      >
        <ConfigProvider config={createTuiResolvedConfig()}>
          <RouteProvider initialRoute={{ type: "home" }}>
            <ClientProvider api={api}>
              <DataProvider directory={temporary.path}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <Keymap.Provider>
                      <ToastProvider>
                        <DialogProvider>
                          <OpenDialog />
                        </DialogProvider>
                      </ToastProvider>
                    </Keymap.Provider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </RouteProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    const frame = await app.waitForFrame((value) => value.includes(marker))
    expect(frame).not.toMatch(FRAME_CONTROL)
    expect(frame.includes(CLEAR)).toBe(false)
    expect(frame.includes(OSC)).toBe(false)
    return frame
  } finally {
    app.renderer.destroy()
  }
}

test("alert title and message strip terminal control bytes", async () => {
  const frame = await renderDialog(
    () => <DialogAlert title={`ALERT${CLEAR}TITLE`} message={`MESSAGE${OSC}BODY`} />,
    "ALERTTITLE",
  )
  expect(frame).toContain("ALERTTITLE")
  expect(frame).toContain("MESSAGEBODY")
})

test("confirm title and message strip terminal control bytes", async () => {
  const frame = await renderDialog(
    () => <DialogConfirm title={`CONFIRM${CLEAR}TITLE`} message={`MESSAGE${OSC}BODY`} />,
    "CONFIRMTITLE",
  )
  expect(frame).toContain("CONFIRMTITLE")
  expect(frame).toContain("MESSAGEBODY")
})

test("error details title, source and error strip terminal control bytes", async () => {
  const frame = await renderDialog(
    () => (
      <DialogErrorDetails
        title={`ERROR${CLEAR}TITLE`}
        source={`/tmp/${CLEAR}source/EVIL${OSC}FILE.ts`}
        error={`FAILED${CLEAR}ERROR`}
        context={`CONTEXT${OSC}LINE`}
        diagnosticRef="err_sink"
        onBack={() => undefined}
      />
    ),
    "ERRORTITLE",
  )
  expect(frame).toContain("EVILFILE.ts")
  expect(frame).toContain("FAILEDERROR")
})
