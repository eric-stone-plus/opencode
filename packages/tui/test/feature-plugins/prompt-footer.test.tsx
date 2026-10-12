/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { PromptFooter } from "../../src/feature-plugins/prompt/footer"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("prompt footer separates simultaneous subagent, shell, and usage status", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const subdued = RGBA.fromInts(100, 100, 100)
  const dispatched: string[] = []
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: subdued,
      },
    },
    keymap: {
      shortcuts: (id: string) =>
        id === "session.child.first" ? ["ctrl+j"] : id === "command.palette.show" ? ["ctrl+p"] : [],
      dispatch: (id: string) => dispatched.push(id),
    },
    data: {
      session: {
        family: () => ["session", "child"],
        status: (id: string) => (id === "child" ? "running" : "idle"),
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        message: { list: () => [] },
      },
      shell: {
        list: () => [{ metadata: { sessionID: "session" } }],
      },
      location: {
        model: { list: () => [] },
      },
    },
  } as unknown as Context
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />
      </ConfigProvider>
    ),
    {
      width: 80,
      height: 2,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ctrl+j 1 subagent · 1 shell · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    await app.mockMouse.moveTo(2, 0)
    const live = app.renderer.root.getChildren()[0]?.getChildren()[0]?.getChildren()[0]
    expect(live).toBeInstanceOf(TextRenderable)
    expect((live as TextRenderable).fg.toInts()).toEqual(color.toInts())

    await app.mockMouse.click(2, 0)
    expect(dispatched).toEqual(["session.child.first"])
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer can hide details", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: color,
      },
    },
    keymap: {
      shortcuts: (id: string) => {
        if (id === "command.palette.show") return ["ctrl+p"]
        if (id === "agent.cycle") return ["shift+tab"]
        return []
      },
    },
    data: {
      session: {
        family: () => ["session"],
        status: () => "running",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        message: {
          list: () => [
            {
              id: "message",
              type: "assistant",
              model: { providerID: "provider", id: "model" },
              time: { created: 0 },
              tokens: { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      },
      shell: { list: () => [] },
      location: {
        model: { list: () => [{ providerID: "provider", id: "model", limit: { context: 10_000 } }] },
      },
    },
  } as unknown as Context
  const [showDetails, setShowDetails] = createSignal(true)
  const [sessionID, setSessionID] = createSignal<string | undefined>("session")
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <PromptFooter
            context={context}
            sessionID={sessionID()}
            mode="normal"
            showDetails={showDetails()}
          />
        </box>
      </ConfigProvider>
    ),
    {
      width: 80,
      height: 1,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1.0K (10%) · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    setShowDetails(false)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("1.0K (10%)")
    expect(frame).not.toContain("$1.00")
    expect(frame).not.toContain("ctrl+p commands")

    setSessionID(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("shift+tab agents")
  } finally {
    app.renderer.destroy()
  }
})

function speedContext(messages: unknown[]) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    location: { directory: "/workspace" },
    theme: { text: { base: color, muted: color } },
    keymap: { shortcuts: (id: string) => (id === "command.palette.show" ? ["ctrl+p"] : []) },
    data: {
      session: {
        family: () => ["session"],
        status: () => "idle",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        message: { list: () => messages },
      },
      shell: { list: () => [] },
      location: {
        model: { list: () => [{ providerID: "provider", id: "model", limit: { context: 10_000 } }] },
      },
    },
  } as unknown as Context
}

const settled = {
  id: "message",
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  content: [{ type: "reasoning", text: "", time: { created: 900 } }],
  time: { created: 0, streamed: 1_000, completed: 1_200 },
  tokens: { input: 1_000, output: 20, reasoning: 20, cache: { read: 0, write: 0 } },
}

test("prompt footer shows the measured speed cells after context and cost", async () => {
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <PromptFooter context={speedContext([settled])} sessionID="session" mode="normal" showDetails={true} />
      </ConfigProvider>
    ),
    { width: 100, height: 1 },
  )
  try {
    await app.renderOnce()
    // 1.0K + 40 generated tokens against 10K context, 900 ms to the first reasoning, 40 tokens in 1 s
    expect(app.captureCharFrame()).toContain("1.0K (10%) · $1.00 · TTFT avg 900ms · 40 tok/s")
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer omits unmeasured speed cells and honors the TPS setting", async () => {
  const unmeasured = { ...settled, content: [], time: { created: 0 }, tokens: undefined }
  const render = (config: ReturnType<typeof createTuiResolvedConfig>, messages: unknown[]) =>
    testRender(
      () => (
        <ConfigProvider config={config}>
          <PromptFooter context={speedContext(messages)} sessionID="session" mode="normal" showDetails={true} />
        </ConfigProvider>
      ),
      { width: 100, height: 1 },
    )
  const measured = await render(createTuiResolvedConfig({ session: { tps: false } }), [settled])
  try {
    await measured.renderOnce()
    expect(measured.captureCharFrame()).not.toContain("TTFT")
    expect(measured.captureCharFrame()).not.toContain("tok/s")
  } finally {
    measured.renderer.destroy()
  }
  const waiting = await render(createTuiResolvedConfig(), [unmeasured])
  try {
    await waiting.renderOnce()
    expect(waiting.captureCharFrame()).not.toContain("TTFT")
    expect(waiting.captureCharFrame()).not.toContain("tok/s")
  } finally {
    waiting.renderer.destroy()
  }
})
