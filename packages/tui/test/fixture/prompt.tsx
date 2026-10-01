/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, Show } from "solid-js"
import path from "node:path"
import { ArgsProvider } from "../../src/context/args"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptStashProvider, usePromptStash } from "../../src/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider, useToast } from "../../src/ui/toast"
import { TestTuiContexts } from "./tui-environment"
import { createEventSource, createFetch, directory, json } from "./tui-sdk"
import { createTuiResolvedConfig } from "./tui-runtime"

export async function wait(fn: () => boolean) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

export function pendingResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => (resolve = done))
  return { promise, resolve }
}

export async function mountPrompt(
  state: string,
  handle: (request: Request) => Promise<Response> | Response | undefined,
) {
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", options: {}, permission: [] }])
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", models: { model: { id: "model", name: "Model", variants: {} } } }],
        default: { test: "model" },
      })
    if (url.pathname === "/session/status") return json({ ses_a: { type: "busy" }, ses_b: { type: "busy" } })
  }, events)
  const requests: Request[] = []
  const fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    return (await handle(request)) ?? calls.fetch(request)
  }) as typeof globalThis.fetch
  let prompt: PromptRef | undefined
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>
  let stash!: ReturnType<typeof usePromptStash>
  let toast!: ReturnType<typeof useToast>
  let local!: ReturnType<typeof useLocal>
  const [visible, setVisible] = createSignal(true)
  const [disabled, setDisabled] = createSignal(false)

  function Composer() {
    route = useRoute()
    sync = useSync()
    stash = usePromptStash()
    toast = useToast()
    local = useLocal()
    return (
      <Show when={visible()}>
        <Prompt
          sessionID={route.data.type === "session" ? route.data.sessionID : undefined}
          disabled={disabled()}
          ref={(value) => (prompt = value)}
        />
      </Show>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: { app_exit: "none" } })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state, home: state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID: "ses_a" }}>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <DataProvider>
                              <ThemeProvider mode="dark">
                                <ToastProvider>
                                  <LocalProvider>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <EditorContextProvider integration={{}}>
                                              <LocationProvider>
                                                <Composer />
                                              </LocationProvider>
                                            </EditorContextProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocalProvider>
                                </ToastProvider>
                              </ThemeProvider>
                            </DataProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </KVProvider>
          </ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { useThread: false, kittyKeyboard: true })
  await wait(() => sync?.status === "complete" && prompt !== undefined)
  await Bun.sleep(10)
  return {
    app,
    keymap,
    route,
    sync,
    stash,
    toast,
    local,
    events,
    requests,
    setVisible,
    setDisabled,
    get prompt() {
      if (!prompt) throw new Error("prompt is not mounted")
      return prompt
    },
    [Symbol.dispose]() {
      prompt?.reset()
      app.renderer.destroy()
    },
  }
}
