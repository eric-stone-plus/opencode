import { execFile, spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

function command(command: string, args: string[] = [], input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
    const output: Buffer[] = []
    child.on("error", reject)
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(output))
      reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

export type ClipboardEnv = Readonly<Record<string, string | undefined>>

export function osc52Sequence(text: string, env: ClipboardEnv) {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  const passthrough = `\x1bPtmux;\x1b${sequence}\x1b\\`
  return env.TMUX ? sequence + passthrough : env.STY ? passthrough : sequence
}

// OSC 52 is fire-and-forget: the terminal never acknowledges it, and many
// (Terminal.app, tmux without set-clipboard) silently drop it. It only counts
// as the copy path when the session is remote, where the host's clipboard
// tool cannot reach the user's machine and OSC 52 is the intended route.
export function isRemoteTerminal(env: ClipboardEnv) {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT)
}

export async function read() {
  if (platform() === "darwin") {
    const file = path.join(tmpdir(), "opencode-clipboard.png")
    try {
      await exec("osascript", [
        "-e",
        'set imageData to the clipboard as "PNGf"',
        "-e",
        `set fileRef to open for access POSIX file "${file}" with write permission`,
        "-e",
        "set eof fileRef to 0",
        "-e",
        "write imageData to fileRef",
        "-e",
        "close access fileRef",
      ])
      return { data: (await readFile(file)).toString("base64"), mime: "image/png" }
    } catch {
      // Fall through to text clipboard.
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const image = await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script]).catch(() =>
      Buffer.alloc(0),
    )
    if (image.length) return { data: image.toString().trim(), mime: "image/png" }
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(() => Buffer.alloc(0))
    if (wayland.length) return { data: wayland.toString("base64"), mime: "image/png" }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(() =>
      Buffer.alloc(0),
    )
    if (x11.length) return { data: x11.toString("base64"), mime: "image/png" }
  }

  const { default: clipboardy } = await import("clipboardy")
  const text = await clipboardy.read().catch(() => undefined)
  if (text) return { data: text, mime: "text/plain" }
}

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
}

export type CopyDeps = {
  platform: NodeJS.Platform
  env: ClipboardEnv
  which(name: string): boolean
  run(command: string, args: string[], input?: string): Promise<unknown>
  fallback(text: string): Promise<void>
}

export function createCopyMethod(deps: CopyDeps): (text: string) => Promise<void> {
  const native = copyCommand(deps.platform, Boolean(deps.env.WAYLAND_DISPLAY), deps.which)
  if (native?.[0] === "osascript") {
    return async (text) => {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      await deps.run("osascript", ["-e", `set the clipboard to "${escaped}"`])
    }
  }
  if (native) {
    return async (text) => {
      await deps.run(native[0], native.slice(1), text)
    }
  }
  return deps.fallback
}

export type WriteDeps = {
  env: ClipboardEnv
  tty: boolean
  emit(sequence: string): void
  copy(text: string): Promise<void>
}

export async function writeWith(text: string, deps: WriteDeps) {
  // Emit OSC 52 whenever there is a terminal: it is harmless where it is
  // ignored, and over SSH even a "successful" native copy lands on the remote
  // host's clipboard rather than the user's.
  const osc52 = deps.tty
  if (osc52) deps.emit(osc52Sequence(text, deps.env))
  try {
    await deps.copy(text)
  } catch (error) {
    // A native failure is only covered by OSC 52 when OSC 52 is the intended
    // path. Locally there is no way to know the terminal honored it, so report
    // the failure instead of letting callers toast "copied" over nothing.
    if (osc52 && isRemoteTerminal(deps.env)) return
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Clipboard unavailable: ${reason}`, { cause: error })
  }
}

let copyMethod: Promise<(text: string) => Promise<void>> | undefined

function getCopyMethod() {
  return (copyMethod ??= (async () => {
    const { which } = await import("@opencode-ai/core/util/which")
    return createCopyMethod({
      platform: platform(),
      env: process.env,
      which: (name) => Boolean(which(name)),
      run: command,
      fallback: async (text) => {
        const { default: clipboardy } = await import("clipboardy")
        await clipboardy.write(text)
      },
    })
  })())
}

export async function write(text: string) {
  await writeWith(text, {
    env: process.env,
    tty: Boolean(process.stdout.isTTY),
    emit: (sequence) => process.stdout.write(sequence),
    copy: await getCopyMethod(),
  })
}
