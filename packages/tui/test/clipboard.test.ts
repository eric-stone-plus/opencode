import { expect, test } from "bun:test"
import { copyCommand, createCopyMethod, isRemoteTerminal, osc52Sequence, writeWith } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test("only SSH sessions count as remote terminals", () => {
  expect(isRemoteTerminal({})).toBe(false)
  expect(isRemoteTerminal({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(false)
  expect(isRemoteTerminal({ SSH_TTY: "/dev/pts/1" })).toBe(true)
  expect(isRemoteTerminal({ SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" })).toBe(true)
  expect(isRemoteTerminal({ SSH_CLIENT: "10.0.0.1 5000 22" })).toBe(true)
})

test("OSC 52 is wrapped for tmux and screen", () => {
  const plain = `\x1b]52;c;${Buffer.from("x").toString("base64")}\x07`
  expect(osc52Sequence("x", {})).toBe(plain)
  expect(osc52Sequence("x", { TMUX: "1" })).toBe(plain + `\x1bPtmux;\x1b${plain}\x1b\\`)
  expect(osc52Sequence("x", { STY: "1" })).toBe(`\x1bPtmux;\x1b${plain}\x1b\\`)
})

function writer(input: { env?: Record<string, string>; tty?: boolean; fail?: boolean }) {
  const emitted: string[] = []
  const copied: string[] = []
  return {
    emitted,
    copied,
    deps: {
      env: input.env ?? {},
      tty: input.tty ?? true,
      emit: (sequence: string) => emitted.push(sequence),
      copy: async (text: string) => {
        if (input.fail) throw new Error("osascript exited with code 1")
        copied.push(text)
      },
    },
  }
}

test("write resolves when the native copy succeeds", async () => {
  const w = writer({})
  await writeWith("hello", w.deps)
  expect(w.copied).toEqual(["hello"])
  expect(w.emitted).toHaveLength(1)
})

test("write rejects a local native failure even though OSC 52 was emitted", async () => {
  // Terminal.app / tmux without set-clipboard drop OSC 52 silently, so a local
  // TTY is no evidence anything was copied.
  for (const env of [{}, { TMUX: "1" }] as Record<string, string>[]) {
    const w = writer({ env, fail: true })
    await expect(writeWith("hello", w.deps)).rejects.toThrow("Clipboard unavailable: osascript exited with code 1")
    expect(w.emitted).toHaveLength(1)
  }
})

test("write resolves a native failure over SSH where OSC 52 is the intended path", async () => {
  const w = writer({ env: { SSH_TTY: "/dev/pts/1" }, fail: true })
  await writeWith("hello", w.deps)
  expect(w.emitted).toEqual([osc52Sequence("hello", {})])
})

test("write rejects a native failure over SSH without a terminal", async () => {
  const w = writer({ env: { SSH_CONNECTION: "a" }, tty: false, fail: true })
  await expect(writeWith("hello", w.deps)).rejects.toThrow("Clipboard unavailable")
  expect(w.emitted).toEqual([])
})

test("copy method runs the platform command and propagates its failure", async () => {
  const runs: unknown[][] = []
  const fallback = async () => {
    throw new Error("fallback should not run")
  }
  const run = async (...args: unknown[]) => {
    runs.push(args)
    throw new Error("exit 1")
  }
  const mac = createCopyMethod({ platform: "darwin", env: {}, which: (n) => n === "osascript", run, fallback })
  await expect(mac('say "hi" \\')).rejects.toThrow("exit 1")
  expect(runs[0]).toEqual(["osascript", ["-e", 'set the clipboard to "say \\"hi\\" \\\\"']])

  const wayland = createCopyMethod({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    which: (n) => n === "wl-copy",
    run,
    fallback,
  })
  await expect(wayland("text")).rejects.toThrow("exit 1")
  expect(runs[1]).toEqual(["wl-copy", [], "text"])
})

test("copy method falls back when no platform command exists", async () => {
  const seen: string[] = []
  const method = createCopyMethod({
    platform: "linux",
    env: {},
    which: () => false,
    run: async () => {
      throw new Error("no command should run")
    },
    fallback: async (text) => {
      seen.push(text)
    },
  })
  await method("text")
  expect(seen).toEqual(["text"])
})
