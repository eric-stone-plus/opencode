/**
 * Shell output is untrusted. Any command can print escape sequences, and the terminal that eventually
 * receives them interprets OSC 52 (clipboard), `\x1b[2J` (clear), `\x1b]0;` (title) and friends.
 * `strip-ansi` alone is not enough - a bare ESC, a C1 byte, a lone NUL/backspace, or a NUL spliced into
 * an introducer (`\x1b\x00[31m`) survives it and still reaches the terminal.
 *
 * These cases drive the real DialogShellOutput path with those payloads and assert that no control byte
 * from the payload survives into the rendered frame. Regression cover for `util/terminal-output.ts`.
 *
 * Run: cd packages/tui && bun test test/component/shell-output-sanitization.test.tsx --timeout 60000
 */
/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { ShellInfo } from "@opencode/client"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { Writable } from "node:stream"
import stripAnsi from "strip-ansi"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider } from "../../src/context/route"
import { TuiAppProvider } from "../../src/context/runtime"
import { StorageProvider } from "../../src/context/storage"
import { ThemeProvider } from "../../src/context/theme"
import { Composer } from "../../src/routes/session/composer"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const CONTROL = /[\u001b\u009b\u009d\u009c\u0007\u0008\u0000]/

// Records every byte the renderer writes to its stdout (latin1 = byte-preserving).
function createCapture() {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number; getColorDepth: () => number }
  stream.isTTY = true
  stream.columns = 100
  stream.rows = 30
  stream.getColorDepth = () => 24
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("latin1"),
    reset: () => chunks.splice(0),
  }
}

async function setup(width: number, output = "", command = "render-scene --quality high", readyMarker?: string) {
  const temporary = await tmpdir()
  const location = { directory: `${temporary.path}/original` }
  const shell: ShellInfo = {
    id: "sh_fixture",
    command,
    cwd: location.directory,
    shell: "/bin/sh",
    file: `${temporary.path}/capture.out`,
    status: "running",
    metadata: { sessionID: "ses_fixture" },
    time: { started: 0 },
  }
  const state = { output, missing: false, failure: false }
  const requests: { url: URL; method: string }[] = []
  const events = createEventStream()
  const envelope = (data: unknown) => json({ location, data })
  const api = createApi(
    createFetch((url, request) => {
      if (!url.pathname.startsWith("/api/shell")) return undefined
      requests.push({ url, method: request.method })
      if (url.pathname === "/api/shell") return envelope([shell])
      if (state.missing)
        return json({ _tag: "ShellNotFoundError", id: shell.id, message: "Shell not found" }, { status: 404 })
      if (state.failure) return new Response("Unavailable", { status: 503 })
      if (url.pathname === `/api/shell/${shell.id}`) return envelope(shell)
      const bytes = Buffer.from(state.output)
      const cursor = Math.min(Number(url.searchParams.get("cursor") ?? 0), bytes.length)
      const end = Math.min(cursor + Number(url.searchParams.get("limit") ?? 65536), bytes.length)
      return envelope({
        output: bytes.subarray(cursor, end).toString(),
        cursor: end,
        size: bytes.length,
        truncated: false,
      })
    }, events).fetch,
  )

  function Shells() {
    const data = useData()
    const [open, setOpen] = createSignal(true)
    onMount(() => void data.shell.sync(location))
    return <Composer sessionID="ses_fixture" open={open()} defaultTab="shell" onClose={() => setOpen(false)} />
  }

  const capture = createCapture()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <RouteProvider initialRoute={{ type: "session", sessionID: "ses_fixture" }}>
                <ClientProvider api={api}>
                  <DataProvider directory={temporary.path}>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <Keymap.Provider>
                        <ToastProvider>
                          <DialogProvider>
                            <Shells />
                          </DialogProvider>
                        </ToastProvider>
                      </Keymap.Provider>
                    </ThemeProvider>
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ConfigProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    {
      width,
      height: 30,
      kittyKeyboard: true,
      stdout: capture.stream as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
      useThread: false,
    },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(readyMarker ?? shell.command))
  return {
    ...app,
    state,
    shell,
    location,
    requests,
    events,
    capture,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

function dumpAround(raw: string, needle: string, before = 80, after = 160) {
  const idx = raw.lastIndexOf(needle)
  if (idx < 0) return `NEEDLE-NOT-FOUND:${JSON.stringify(needle)}`
  return JSON.stringify(raw.slice(Math.max(0, idx - before), idx + after))
}

const CASES: { name: string; raw: string; sentinel: string; needle: string }[] = [
  { name: "baseline", raw: "", sentinel: "SENTINEL-BASELINE", needle: "SENTINEL-BASELINE" },
  { name: "sgr", raw: "\u001b[31m", sentinel: "SENTINEL-SGR", needle: "SENTINEL-SGR" },
  { name: "csi_erase", raw: "\u001b[2J", sentinel: "SENTINEL-ERASE", needle: "SENTINEL-ERASE" },
  { name: "csi_home", raw: "\u001b[H", sentinel: "SENTINEL-HOME", needle: "SENTINEL-HOME" },
  { name: "alt_screen", raw: "\u001b[?1049h", sentinel: "SENTINEL-ALT", needle: "SENTINEL-ALT" },
  { name: "osc52", raw: "\u001b]52;c;QQ==\u0007", sentinel: "SENTINEL-OSC52", needle: "SENTINEL-OSC52" },
  {
    name: "osc8",
    raw: "\u001b]8;;http://evil.example\u0007x\u001b]8;;\u0007",
    sentinel: "SENTINEL-OSC8",
    needle: "SENTINEL-OSC8",
  },
  { name: "osc_title", raw: "\u001b]0;pwned\u0007", sentinel: "SENTINEL-TITLE", needle: "SENTINEL-TITLE" },
  { name: "dcs", raw: "\u001bPq\u001b\\", sentinel: "SENTINEL-DCS", needle: "SENTINEL-DCS" },
  { name: "c1_csi", raw: "\u009b31m", sentinel: "SENTINEL-C1CSI", needle: "SENTINEL-C1CSI" },
  { name: "cr_overwrite", raw: "AAAA\rBBBB", sentinel: "SENTINEL-CR", needle: "SENTINEL-CR" },
  { name: "backspace", raw: "ABCD\u0008\u0008X", sentinel: "SENTINEL-BS", needle: "SENTINEL-BS" },
  { name: "tab", raw: "A\tB", sentinel: "SENTINEL-TAB", needle: "SENTINEL-TAB" },
  { name: "nul", raw: "A\u0000B", sentinel: "SENTINEL-NUL", needle: "SENTINEL-NUL" },
  { name: "ui_spoof", raw: "Shell output\nExited · code 0\nesc\nAllow permission? [y/N]", sentinel: "SENTINEL-SPOOF", needle: "SENTINEL-SPOOF" },
  { name: "esc_bare_trailing", raw: "TRAIL\u001b", sentinel: "SENTINEL-BAREESC", needle: "SENTINEL-BAREESC" },
  { name: "osc_unterminated", raw: "\u001b]52;c;QQ==UNTERMINATED", sentinel: "SENTINEL-UNTERM", needle: "SENTINEL-UNTERM" },
  { name: "c1_osc_8bit", raw: "\u009d52;c;QQ==\u009c", sentinel: "SENTINEL-C1OSC", needle: "SENTINEL-C1OSC" },
  { name: "c1_st_alone", raw: "A\u009cB", sentinel: "SENTINEL-C1ST", needle: "SENTINEL-C1ST" },
  { name: "esc_backslash", raw: "\u001b\\", sentinel: "SENTINEL-ESCBS", needle: "SENTINEL-ESCBS" },
  { name: "osc_unterminated_then_text", raw: "\u001b]0;pwned\nmore text", sentinel: "SENTINEL-UNTERM2", needle: "SENTINEL-UNTERM2" },
  // falsification: NUL (ignored by terminal parsers) inserted inside the introducer so ansi-regex cannot match
  { name: "nul_gap_sgr", raw: "\u001b\u0000[31mRED", sentinel: "SENTINEL-NULGAP-SGR", needle: "SENTINEL-NULGAP-SGR" },
  { name: "nul_gap_csi_erase", raw: "\u001b\u0000[2J", sentinel: "SENTINEL-NULGAP-ERASE", needle: "SENTINEL-NULGAP-ERASE" },
  { name: "nul_gap_alt_screen", raw: "\u001b\u0000[?1049h", sentinel: "SENTINEL-NULGAP-ALT", needle: "SENTINEL-NULGAP-ALT" },
  { name: "nul_gap_osc52", raw: "\u001b\u0000]52;c;QQ==\u0007", sentinel: "SENTINEL-NULGAP-OSC52", needle: "SENTINEL-NULGAP-OSC52" },
  { name: "nul_gap_osc_title", raw: "\u001b\u0000]0;pwned\u0007", sentinel: "SENTINEL-NULGAP-TITLE", needle: "SENTINEL-NULGAP-TITLE" },
  { name: "nul_gap_osc8", raw: "\u001b\u0000]8;;http://evil.example\u0007x\u001b]8;;\u0007", sentinel: "SENTINEL-NULGAP-OSC8", needle: "SENTINEL-NULGAP-OSC8" },
  { name: "esc_nl_gap", raw: "\u001b\n[31mRED", sentinel: "SENTINEL-NLGAP", needle: "SENTINEL-NLGAP" },
  // padded variants: absorb the per-line tail truncation so the terminator survives
  { name: "nul_gap_csi_erase_pad", raw: "\u001b\u0000[2JXERASE", sentinel: "SENTINEL-PAD-ERASE", needle: "SENTINEL-PAD-ERASE" },
  { name: "nul_gap_alt_pad", raw: "\u001b\u0000[?1049hALT", sentinel: "SENTINEL-PAD-ALT", needle: "SENTINEL-PAD-ALT" },
  { name: "nul_gap_osc52_pad", raw: "\u001b\u0000]52;c;QQ==\u0007CLIP", sentinel: "SENTINEL-PAD-OSC52", needle: "SENTINEL-PAD-OSC52" },
  { name: "nul_gap_osc_title_pad", raw: "\u001b\u0000]0;pwned\u0007TITLE", sentinel: "SENTINEL-PAD-TITLE", needle: "SENTINEL-PAD-TITLE" },
  { name: "nul_gap_osc8_pad", raw: "\u001b\u0000]8;;http://evil.example\u0007xPADPADPAD", sentinel: "SENTINEL-PAD-OSC8", needle: "SENTINEL-PAD-OSC8" },
  { name: "nul_gap_dcs_pad", raw: "\u001b\u0000P1;2|payload\u001b\\PADPAD", sentinel: "SENTINEL-PAD-DCS", needle: "SENTINEL-PAD-DCS" },
  { name: "nul_gap_osc52_long_pad", raw: "\u001b\u0000]52;c;c2VjcmV0LWNsaXBib2FyZA==\u0007PAD", sentinel: "SENTINEL-PAD-OSC52L", needle: "SENTINEL-PAD-OSC52L" },
]

const RECONSTRUCTED: Record<string, string> = {
  nul_gap_sgr: "\u001b\u0000[31m",
  nul_gap_csi_erase_pad: "\u001b\u0000[2J",
  nul_gap_alt_pad: "\u001b\u0000[?1049h",
  nul_gap_osc52_pad: "\u001b\u0000]52;c;QQ==\u0007",
  nul_gap_osc_title_pad: "\u001b\u0000]0;pwned\u0007",
  nul_gap_osc8_pad: "\u001b\u0000]8;;http://evil.example\u0007",
  nul_gap_dcs_pad: "\u001b\u0000P1;2|payload\u001b\\",
  nul_gap_osc52_long_pad: "\u001b\u0000]52;c;c2VjcmV0LWNsaXBib2FyZA==\u0007",
}

for (const entry of CASES) {
  test(`no control byte reaches the frame: ${entry.name}`, async () => {
    const payload = `${entry.sentinel}\n${entry.raw}\n`
    await using app = await setup(100, payload)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Shell output") && frame.includes(entry.sentinel), {
      maxPasses: 200,
    })
    await Bun.sleep(60)
    const frame = app.captureCharFrame()
    const raw = app.capture.text()
    const report = {
      name: entry.name,
      payload: JSON.stringify(payload),
      afterStripAnsi: JSON.stringify(stripAnsi(payload)),
      sentinelSeen: frame.includes(entry.sentinel),
      frameControls: frame.match(CONTROL) ?? [],
      externalEmpty: app.externalOutput.takeText().length === 0,
      rawAroundNeedle: dumpAround(raw, entry.needle),
      frameAroundNeedle: dumpAround(frame, entry.needle, 60, 140),
      rawAfterSentinel: JSON.stringify(raw.slice(Math.max(0, raw.lastIndexOf(entry.sentinel) - 40), raw.lastIndexOf(entry.sentinel) + 700)),
      rawContainsReconstructed: RECONSTRUCTED[entry.name] === undefined ? undefined : raw.includes(RECONSTRUCTED[entry.name]),
      fullFrame: ["cr_overwrite", "ui_spoof", "backspace", "nul"].includes(entry.name) ? JSON.stringify(frame) : undefined,
    }
    expect(report.frameControls, `control bytes reached the frame: ${JSON.stringify(report)}`).toEqual([])
  })
}


test("no control byte reaches the frame: model-authored command line", async () => {
  // The command line itself is model-controlled: it is echoed in the shell tab and in the dialog header.
  const command = "echo hi \u001b]52;c;QQ==\u0007 \u001b[31mred\u001b[0m"
  await using app = await setup(100, "plain output\n", command, "echo hi")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Shell output"), { maxPasses: 200 })
  await Bun.sleep(60)
  const frame = app.captureCharFrame()
  expect(frame.match(CONTROL) ?? [], `command escape reached the frame: ${JSON.stringify(frame)}`).toEqual([])
})
