import type { ToolContext } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export async function location(context: ToolContext, value: string) {
  context.abort.throwIfAborted()
  const target = path.resolve(context.directory, value)
  const parent = await realpath(target).catch(async () => {
    if (target === path.dirname(target)) throw new Error(`Cannot resolve ${target}`)
    return path.join(await existingParent(path.dirname(target)), path.basename(target))
  })
  const root = await realpath(context.worktree || context.directory)
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    await context.ask({
      permission: "external_directory",
      patterns: [path.join(path.dirname(parent), "*")],
      always: [path.join(path.dirname(parent), "*")],
      metadata: { path: parent },
    })
  }
  return parent
}

async function existingParent(value: string): Promise<string> {
  return realpath(value).catch(async () => {
    if (value === path.dirname(value)) throw new Error(`Cannot resolve ${value}`)
    return path.join(await existingParent(path.dirname(value)), path.basename(value))
  })
}

export async function permit(context: ToolContext, permission: "read" | "edit", files: string[]) {
  await context.ask({
    permission,
    patterns: files.map((file) => path.relative(context.worktree || context.directory, file)),
    always: ["*"],
    metadata: { files },
  })
  context.abort.throwIfAborted()
}

export async function save(file: string, content: string, signal: AbortSignal) {
  signal.throwIfAborted()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    signal.throwIfAborted()
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** Own a numeric process group; timeout/cancel tears down its descendants too. */
export function run(
  argv: string[],
  options: { cwd: string; signal: AbortSignal; timeout: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    const state = { bytes: 0, reason: "", settled: false, forced: undefined as ReturnType<typeof setTimeout> | undefined }
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(value)
        else process.kill(-child.pid, value)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    const stop = (reason: string) => {
      if (state.reason) return
      state.reason = reason
      signal("SIGTERM")
      state.forced = setTimeout(() => signal("SIGKILL"), 500)
    }
    const timeout = setTimeout(() => stop(`Timed out after ${options.timeout} ms`), options.timeout)
    const abort = () => stop("Cancelled")
    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()
    const capture = (target: Buffer[], chunk: Buffer) => {
      state.bytes += chunk.length
      if (state.bytes > 4 * 1024 * 1024) return stop("Process output exceeded 4 MiB")
      target.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(output, chunk))
    child.stderr.on("data", (chunk: Buffer) => capture(errors, chunk))
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
    const finish = (error?: Error) => {
      if (state.settled) return
      state.settled = true
      clearTimeout(timeout)
      if (state.forced) clearTimeout(state.forced)
      options.signal.removeEventListener("abort", abort)
      // A successful parent may leave a worker behind. This group belongs only
      // to this tool call, never the OpenCode/TUI process group.
      signal("SIGKILL")
      if (error) return reject(error)
      resolve(Buffer.concat(output).toString())
    }
    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      const detail = Buffer.concat(errors).toString().slice(-6000)
      finish(state.reason || code !== 0 ? new Error(`${state.reason || `Process exited ${code}`}\n${detail}`) : undefined)
    })
  })
}
