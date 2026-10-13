/** @jsxImportSource @opentui/solid */
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

const sessionID = "ses_usage_fixture"

test("usage dialog reports sections, notes, and copies the report", async () => {
  await using temporary = await tmpdir()
  const copied: string[] = []
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
                model: { id: "glm-5.3", providerID: "zhipuai-coding-plan" },
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
            title: "Usage fixture",
            location: { directory: temporary.path },
            cost: 0.42,
            tokens: { input: 12_000, output: 400, reasoning: 0, cache: { read: 2_000, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
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
        clipboard={{ read: async () => undefined, write: async (text) => void copied.push(text) }}
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
    const frame = app.captureCharFrame()
    expect(frame).toContain("Session Usage")
    expect(frame).toContain("Input tokens")
    expect(frame).toContain("Cost")
    expect(frame).toContain("Prompts")
    expect(frame).toContain("c session id · y copy report")

    // V2's Dialog defaults to a top-quarter offset; /usage opts into both-axes centring so
    // the margins above and below stay balanced on any viewport (a short landscape was the
    // reported case, where the old offset pushed the body off the bottom).
    const lines = frame.replace(/\n$/, "").split("\n")
    const heading = lines.findIndex((line) => line.includes("Session Usage"))
    const footer = lines.findIndex((line) => line.includes("c session id"))
    expect(heading).toBeGreaterThanOrEqual(2)
    expect(footer).toBeGreaterThan(heading)
    expect(Math.abs(heading - (lines.length - 1 - footer))).toBeLessThanOrEqual(3)

    // The tail of the report (By model, notes) lives below the fold.
    const scroll = app.renderer.root.findDescendantById("usage-scroll")
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("usage scrollbox missing")
    expect(scroll.scrollTop).toBe(0)
    app.mockInput.pressKey("END")
    await app.waitFor(() => scroll.scrollTop > 0)
    await app.waitForFrame((f) => f.includes("Subscription plans have no per-token prices"))
    const scrolled = app.captureCharFrame()
    expect(scrolled).toContain("deepseek/deepseek-flash#max")
    expect(scrolled).toContain("Source: recorded step usage")

    app.mockInput.pressKey("y")
    await app.waitFor(() => copied.length === 1)
    expect(copied[0]).toContain("Input tokens: 12.0K")
    expect(copied[0]).toContain("Tool calls: 7 · 1 failed")
    expect(copied[0]).toContain("Session ID: " + sessionID)
    expect(copied[0]).toContain("deepseek/deepseek-flash#max: $0.42 · 3 steps")
    expect(copied[0]).toContain("Source: recorded step usage")
    expect(copied[0]).toContain("Subscription plans have no per-token prices")

    app.mockInput.pressKey("c")
    await app.waitFor(() => copied.length === 2)
    expect(copied[1]).toBe(sessionID)
  } finally {
    app.renderer.destroy()
  }
})
