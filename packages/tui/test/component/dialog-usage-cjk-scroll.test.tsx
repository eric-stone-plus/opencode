/** @jsxImportSource @opentui/solid */
// Regression guard for the reported CJK-scroll symptom: Chinese text inside a scrolled
// scrollbox body disappears. The dialog body must keep wide characters both before and
// after END-scrolling the model section into view. Modelled on dialog-usage.test.tsx.
import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogUsage } from "../../src/component/dialog-usage"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const sessionID = "ses_cjk_scroll"
const CJK_MODEL = "中文模型-甲乙丙"

test("CJK survives scrolling the usage body", async () => {
  await using temporary = await tmpdir()
  const api = createApi(
    createFetch((url) => {
      if (url.pathname === "/api/experimental/session/stats")
        return json({
          data: {
            range: { from: 0, to: 0 },
            sessions: 1,
            subagents: 2,
            prompts: 3,
            steps: 5,
            compactions: 1,
            tokens: { input: 12_000, output: 400, reasoning: 0, cache: { read: 2_000, write: 0 } },
            cost: 0.42,
            tools: { mode: "summary", totals: { calls: 7, succeeded: 6, failed: 1, unfinished: 0 } },
            activeDays: 1,
            streak: 1,
            activity: [],
            models: [
              {
                model: { id: "deepseek-flash", providerID: "deepseek", variant: "max" },
                steps: 3,
                compactions: 0,
                tokens: { input: 10_000, output: 300, reasoning: 0, cache: { read: 2_000, write: 0 } },
                cost: 0.42,
              },
              {
                model: { id: CJK_MODEL, providerID: "中文厂" },
                steps: 2,
                compactions: 1,
                tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              },
            ],
          },
        })
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "proj_test",
            title: "中文会话标题",
            location: { directory: temporary.path },
            cost: 0.42,
            tokens: { input: 12_000, output: 400, reasoning: 0, cache: { read: 2_000, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        if (url.searchParams.get("type") === "compaction")
          return json({
            data: [
              { id: "msg_compaction_1", sessionID, type: "compaction", status: "completed", time: { created: 1 } },
              { id: "msg_compaction_2", sessionID, type: "compaction", status: "completed", time: { created: 2 } },
            ],
            cursor: {},
          })
        return json({ data: [], cursor: {} })
      }
      if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
        return json({ data: [] })
      return undefined
    }, createEventStream()).fetch,
  )

  function OpenDialog() {
    const dialog = useDialog()
    const data = useData()
    onMount(() => {
      void data.session.sync(sessionID)
      dialog.replace(() => <DialogUsage sessionID={sessionID} />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={temporary.path}
        paths={{ state: temporary.path }}
        clipboard={{ read: async () => undefined, write: async () => {} }}
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
    { width: 100, height: 30, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Session Usage") && frame.includes("Input tokens"))
    expect(app.captureCharFrame()).toContain("中文会话标题")

    const scroll = app.renderer.root.findDescendantById("usage-scroll")
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("usage scrollbox missing")
    app.mockInput.pressKey("END")
    await app.waitFor(() => scroll.scrollTop > 0)
    await app.waitForFrame((f) => f.includes("Subscription plans have no per-token prices"))

    const scrolled = app.captureCharFrame()
    expect(scrolled).toContain("deepseek/deepseek-flash#max")
    expect(scrolled).toContain(CJK_MODEL)
    expect(scrolled).toContain("中文厂")
  } finally {
    app.renderer.destroy()
  }
})
