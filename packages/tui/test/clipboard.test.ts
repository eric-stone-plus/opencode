import { expect, test } from "bun:test"
import { copyCommand } from "../src/clipboard"

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

// write() runs in a child process whose PATH holds only a failing wl-copy, so
// the native copy always fails and no real clipboard is touched.
async function writeWithFailingNative(tty: boolean) {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises")
  const path = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(path.join(tmpdir(), "clip-"))
  try {
    await writeFile(path.join(dir, "wl-copy"), "#!/bin/sh\ncat >/dev/null\nexit 1\n")
    await chmod(path.join(dir, "wl-copy"), 0o755)
    const script = `
      Object.defineProperty(process.stdout, "isTTY", { value: ${tty} })
      process.stdout.write = () => true
      const { write } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/clipboard.ts"))})
      await write("x").then(() => process.exit(0), () => process.exit(3))
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: dir, WAYLAND_DISPLAY: "wayland-test", HOME: dir },
      stdout: "ignore",
      stderr: "pipe",
    })
    return await proc.exited
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("write rejects when no copy path worked", async () => {
  if (process.platform !== "linux") return
  expect(await writeWithFailingNative(false)).toBe(3)
})

test("write resolves when OSC 52 reached the terminal even if the native copy failed", async () => {
  if (process.platform !== "linux") return
  expect(await writeWithFailingNative(true)).toBe(0)
})
