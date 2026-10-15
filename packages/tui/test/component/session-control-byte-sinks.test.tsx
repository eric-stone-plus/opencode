/** @jsxImportSource @opentui/solid */
// Session content is untrusted: assistant text, tool input, tool output, diffs and diagnostics all carry
// bytes chosen by a model, a file, or a remote server. The renderer does not filter control bytes, so a
// terminal receiving them interprets OSC 52 (clipboard write), `\x1b[2J` (clear) and friends as commands.
// `util/terminal-output.ts` sanitizes at the projection layer; this suite drives the real session route
// with payloads in each always-visible and click-expanded sink and asserts no payload byte reaches the
// rendered frame or the renderer's stdout stream. It is the regression cover for the projection layer
// that `shell-output-sanitization.test.tsx` does not touch.
//
// Run: cd packages/tui && bun test test/component/session-control-byte-sinks.test.tsx --timeout 60000
import { expect, test } from "bun:test"
import { createAppFixture } from "../fixture/app"
import { directory, json } from "../fixture/tui-client"
import { tmpdir } from "../fixture/fixture"

type Renderer = {
  realStdoutWrite: (...args: unknown[]) => unknown
  stdout: NodeJS.WriteStream
}

// Records every byte the renderer writes to its stdout (latin1 = byte-preserving).
function captureStdout(setup: { renderer: unknown }) {
  const renderer = setup.renderer as Renderer
  const chunks: Buffer[] = []
  const original = renderer.realStdoutWrite
  renderer.realStdoutWrite = function (chunk: unknown, ...rest: unknown[]) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : Buffer.from(chunk as Uint8Array))
    return original.call(renderer.stdout, chunk, ...rest)
  }
  return {
    text: () => Buffer.concat(chunks).toString("latin1"),
    restore: () => {
      renderer.realStdoutWrite = original
    },
  }
}

const session = {
  id: "ses_sink",
  title: "Sink fixture",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"
// Tab and newline are the only control bytes a rendered frame may carry (the renderer separates rows
// with newlines); anything else in the grid is a byte the terminal would interpret as a command.
const FRAME_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

async function run(
  marker: string,
  content: unknown[],
  options?: { clickMarker?: boolean; payload?: string },
) {
  const payload = options?.payload ?? CLEAR
  await using state = await tmpdir()
  const messages = [
    {
      id: "msg_sink",
      type: "assistant",
      agent: "build",
      model: session.model,
      time: { created: 2, completed: 3 },
      finish: "stop",
      content,
    },
  ]
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    state: state.path,
    config: { animations: false },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if (/^\/api\/session\/ses_sink\/(inbox|permission|form|todo)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      return undefined
    },
  })
  const capture = captureStdout(setup)
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes(marker), { maxPasses: 120 })
    await setup.renderOnce()
    await Bun.sleep(100)
    if (options?.clickMarker) {
      const lines = setup.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(marker))
      if (row >= 0) {
        await setup.mockMouse.click(12, row)
        await setup.renderOnce()
        await Bun.sleep(150)
        await setup.renderOnce()
      }
    }
    const frame = setup.captureCharFrame()
    const raw = capture.text()
    // The marker proves the sink rendered at all. The frame is a character grid, so every control byte
    // in it is a leak; asserting the property (rather than one payload string) also catches payloads the
    // terminal width truncated, which a `frame.includes(payload)` check would miss.
    expect(frame.includes(marker)).toBe(true)
    expect(frame).not.toMatch(FRAME_CONTROL)
    expect(frame.includes(payload)).toBe(false)
    expect(raw.includes(payload)).toBe(false)
  } finally {
    capture.restore()
  }
}

test("assistant text carries no control bytes into the frame", async () => {
  await run("SINK-TEXT", [{ type: "text", text: `SINK-TEXT ${CLEAR} tail` }])
})

test("write tool input content carries no control bytes into the frame", async () => {
  await run(
    "SINK-WRITE",
    [
      {
        type: "tool",
        id: "call_write",
        name: "write",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: { path: "notes.md", content: `SINK-WRITE\n${OSC}\n` },
          metadata: {},
          content: [{ type: "text", text: "Wrote notes.md" }],
        },
      },
    ],
    { payload: OSC },
  )
})

test("generic tool input summary carries no control bytes into the frame", async () => {
  await run("SINK-ARGS", [
    {
      type: "tool",
      id: "call_generic",
      name: "mcp_evil_echo",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed",
        input: { text: `SINK-ARGS${CLEAR}Z` },
        metadata: {},
        content: [{ type: "text", text: "ok" }],
      },
    },
  ])
})

test("generic tool output carries no control bytes after expanding", async () => {
  await run(
    "SINK-OUT",
    [
      {
        type: "tool",
        id: "call_generic_out",
        name: "mcp_evil_echo",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: { cmd: "SINK-OUT" },
          metadata: {},
          content: [{ type: "text", text: `SINK-OUT\n${CLEAR}\nEND` }],
        },
      },
    ],
    { clickMarker: true },
  )
})

test("tool error carries no control bytes after expanding", async () => {
  await run(
    "SINK-ERR",
    [
      {
        type: "tool",
        id: "call_err",
        name: "mcp_evil_fail",
        time: { created: 2, completed: 3 },
        state: {
          status: "error",
          input: { cmd: "SINK-ERR" },
          metadata: {},
          error: { type: "tool", message: `SINK-ERR ${CLEAR} boom` },
        },
      },
    ],
    { clickMarker: true },
  )
})

test("patch diff carries no control bytes into the frame", async () => {
  await run("SINK-PATCH", [
    {
      type: "tool",
      id: "call_patch",
      name: "apply_patch",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed",
        input: { patchText: "*** Update File: notes.md" },
        metadata: {
          files: [
            {
              type: "update",
              file: "notes.md",
              filePath: "notes.md",
              patch: `--- a/notes.md\n+++ b/notes.md\n@@ -1,1 +1,2 @@\n unchanged\n+SINK-PATCH-${CLEAR}-added\n`,
              additions: 1,
              deletions: 0,
            },
          ],
        },
        content: [{ type: "text", text: "Patched" }],
      },
    },
  ])
})

test("diagnostics carry no control bytes into the frame", async () => {
  await run("SINK-DIAG", [
    {
      type: "tool",
      id: "call_diag",
      name: "write",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed",
        input: { path: "notes.md", content: "SINK-DIAG\n" },
        metadata: {
          diagnostics: {
            "notes.md": [
              { severity: 1, message: `SINK-DIAG-${CLEAR}-ts2322`, range: { start: { line: 0, character: 0 } } },
            ],
          },
        },
        content: [{ type: "text", text: "Wrote notes.md" }],
      },
    },
  ])
})

test("shell output carries no control bytes into the frame", async () => {
  await run("SINK-SHELL", [
    {
      type: "tool",
      id: "call_shell",
      name: "bash",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed",
        input: { command: "echo SINK-SHELL" },
        metadata: {},
        content: [{ type: "text", text: `SINK-SHELL ${CLEAR} done` }],
      },
    },
  ])
})

test("sidebar session title carries no control bytes into the frame", async () => {
  await using state = await tmpdir()
  const titled = { ...session, id: "ses_sink_title", title: `SINK-TITLE${CLEAR}X` }
  await using setup = await createAppFixture({
    width: 150,
    height: 26,
    state: state.path,
    config: { animations: false, session: { sidebar: "auto" } },
    args: { sessionID: titled.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${titled.id}`) return json({ data: titled })
      if (url.pathname === `/api/session/${titled.id}/message`) return json({ data: [], cursor: {} })
      if (/^\/api\/session\/ses_sink_title\/(inbox|permission|form|todo)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      return undefined
    },
  })
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("SINK-TITLE"), { maxPasses: 120 })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // The sidebar title is model-generated, so the same frame rule applies here.
    expect(frame.includes("SINK-TITLE")).toBe(true)
    expect(frame).not.toMatch(FRAME_CONTROL)
  } finally {
    /* noop */
  }
})
