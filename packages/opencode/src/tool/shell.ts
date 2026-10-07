import { Effect, Fiber, Schedule, Scope, Semaphore, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import { Agent } from "@/agent/agent"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
// Upper bound for a model-supplied timeout unless OPENCODE_EXPERIMENTAL_BASH_MAX_TIMEOUT_MS overrides it.
export const DEFAULT_MAX_TIMEOUT_MS = 30 * 60 * 1000
// Node timers overflow above a signed 32-bit int and fire immediately. Leave room for the +100ms grace.
const TIMER_MAX_MS = 2_147_483_647 - 1_000
const GROUP_KILL_GRACE_MS = 3_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
  startsMidLine: boolean
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

export function timeoutLimits(flags: { bashDefaultTimeoutMs?: number; bashMaxTimeoutMs?: number }) {
  const max = Math.min(
    flags.bashMaxTimeoutMs ?? Math.max(DEFAULT_MAX_TIMEOUT_MS, flags.bashDefaultTimeoutMs ?? 0),
    TIMER_MAX_MS,
  )
  return { max, default: Math.min(flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000, max) }
}

// A POSIX process group outlives its leader while members remain, so `-pgid` keeps
// addressing exactly the background jobs a finished command left behind.
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal)
  } catch {}
}

const killGroups = (pgids: number[]) =>
  Effect.gen(function* () {
    const live = pgids.filter(groupAlive)
    if (live.length === 0) return
    for (const pgid of live) signalGroup(pgid, "SIGTERM")
    const deadline = Date.now() + GROUP_KILL_GRACE_MS
    while (Date.now() < deadline && live.some(groupAlive)) yield* Effect.sleep("100 millis")
    for (const pgid of live) if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL")
  })

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service
    const agents = yield* Agent.Service
    const limitsMs = timeoutLimits(flags)
    const defaultTimeoutMs = limitsMs.default
    const maxTimeoutMs = limitsMs.max

    // Background jobs (`cmd &`, nohup) survive a successful command on purpose: dev
    // servers and watchers are legitimate for the rest of the session. Their process
    // groups are reaped when the session is deleted, its instance is disposed, or the
    // tool layer shuts down. `setsid`/daemonizers leave the group and are not tracked.
    const groups = new Map<number, { sessionID: string; directory: string }>()
    const reap = (match: (owner: { sessionID: string; directory: string }) => boolean) =>
      Effect.suspend(() => {
        const pgids = [...groups].filter(([, owner]) => match(owner)).map(([pgid]) => pgid)
        for (const pgid of pgids) groups.delete(pgid)
        return killGroups(pgids)
      })
    const track = (pgid: number, owner: { sessionID: string; directory: string }) =>
      Effect.sync(() => {
        for (const known of [...groups.keys()]) if (!groupAlive(known)) groups.delete(known)
        if (groupAlive(pgid)) groups.set(pgid, owner)
      })
    yield* Effect.addFinalizer(() => reap(() => true))
    const scope = yield* Scope.Scope
    // Listeners run inline with the publisher (Session.remove); don't hold it through the kill grace.
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
      const sessionID = (event.data as { sessionID: string }).sessionID
      return reap((owner) => owner.sessionID === sessionID).pipe(Effect.forkIn(scope), Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const instances = yield* InstanceState.make<void>((instance) =>
      Effect.addFinalizer(() => reap((owner) => owner.directory === instance.directory)),
    )

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        directory: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      // Retain the true head and the true tail of the stream so the final window can
      // show both ends of the output. Each buffer holds up to maxBytes (chunk
      // granularity can overshoot); once both are full the middle is dropped here and
      // only ever lives in the spill file the sink streams to.
      const headKeep = limits.maxBytes
      const tailKeep = limits.maxBytes
      let full = ""
      let last = ""
      const headChunks: Chunk[] = []
      const tailChunks: Chunk[] = []
      let headUsed = 0
      let tailUsed = 0
      let totalBytes = 0
      let totalBreaks = 0
      let dropped = false
      let prevEndedWithNewline = true
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      let published = ""
      const publishing = Semaphore.makeUnsafe(1)
      const pushMeta = publishing.withPermits(1)(
        Effect.gen(function* () {
          if (last === published) return
          const output = last
          yield* ctx.metadata({ metadata: { output } })
          published = output
        }),
      )

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      let pgid: number | undefined
      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
          // Non-Windows shells run detached, so the shell pid is the process group id.
          if (process.platform !== "win32") pgid = handle.pid

          // Publish the first chunk immediately, then sample at 100ms. A trailing
          // flush is essential when a burst is followed by a long-running job
          // that emits nothing else (a chunk-only throttle loses that tail).
          yield* Effect.forkScoped(pushMeta.pipe(Effect.repeat(Schedule.spaced("100 millis"))))

          const reader = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              totalBytes += size
              totalBreaks += chunk.split("\n").length - 1
              const aligned = prevEndedWithNewline

              if (headUsed < headKeep) {
                headChunks.push({ text: chunk, size, startsMidLine: !aligned })
                headUsed += size
              } else {
                tailChunks.push({ text: chunk, size, startsMidLine: !aligned })
                tailUsed += size
                while (tailUsed > tailKeep && tailChunks.length > 1) {
                  const item = tailChunks.shift()
                  if (!item) break
                  tailUsed -= item.size
                  dropped = true
                  cut = true
                }
              }
              prevEndedWithNewline = chunk.endsWith("\n")

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  // Spill streams the full output here; after abort/timeout the
                  // reader may never see the rest of the pipe (join is time-boxed),
                  // so this file can be a prefix of the true output.
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(() => (published ? Effect.void : pushMeta)),
                  )
                }
              }

              return published ? Effect.void : pushMeta
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          // kill waits for the process to report exit; never let that wedge the tool.
          const kill = handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie, Effect.timeout("5 seconds"), Effect.ignore)
          if (exit.kind === "abort") {
            aborted = true
            yield* kill
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* kill
          }

          // Output can still be in flight when the exit is reported. The reader ends
          // at EOF, or when the spawner drops pipes held by detached descendants.
          yield* Fiber.join(reader).pipe(Effect.timeout("2 seconds"), Effect.ignore)
          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.ensuring(pushMeta), Effect.orDie)

      if (pgid !== undefined) yield* track(pgid, { sessionID: ctx.sessionID, directory: input.directory })

      const meta: string[] = []
      if (expired) {
        meta.push(
          input.timeout >= maxTimeoutMs
            ? `shell tool terminated command after reaching the maximum timeout of ${input.timeout} ms. Run long jobs in the background (e.g. \`nohup cmd > log 2>&1 &\`) and poll their output instead.`
            : `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds (max ${maxTimeoutMs}).`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const headText = headChunks.map((item) => item.text).join("")
      const tailText = tailChunks.map((item) => item.text).join("")
      // Derived from the retained first tail chunk (not captured at first push):
      // tail trims can shift that chunk away, leaving one that starts mid-line.
      const tailStartsMidLine = tailChunks[0]?.startsMidLine ?? false
      // A dropped middle implies the stream already spilled the full output to `file`
      // (the sink opens before retention trims can fire), so the end-of-run write below
      // only ever runs on the complete retained text.
      const raw = headText + tailText
      const totalLines = totalBreaks + 1
      // Fits-check parity with Truncate.output: within both budgets the retained text
      // is the whole output and is returned verbatim — windowing would still cut
      // (head/tail only share 70/30 of the budgets) and falsely mark it truncated.
      const fits = totalLines <= limits.maxLines && totalBytes <= limits.maxBytes
      const win = fits
        ? {
            head: { text: raw, lines: totalLines, bytes: totalBytes },
            tail: { text: "", lines: 0, bytes: 0 },
            elidedLines: 0,
            elidedBytes: 0,
            cut: false,
          }
        : dropped
          ? Truncate.windowParts(
              headText,
              tailText,
              { lines: totalLines, bytes: totalBytes },
              limits.maxLines,
              limits.maxBytes,
              tailStartsMidLine,
            )
          : Truncate.windowText(raw, limits.maxLines, limits.maxBytes)
      if (win.cut) cut = true
      // Abort/timeout caveat: the reader join above is time-boxed (2s), so output
      // still held in a pipe by a detached descendant never reaches `file` via the
      // sink. The marker then reports the spill as partial (aborted || expired).
      if (cut && !file) {
        file = yield* trunc.write(raw)
      }

      let output: string
      if (!cut) {
        output = raw
      } else {
        const block = Truncate.marker({
          elidedLines: win.elidedLines,
          elidedBytes: win.elidedBytes,
          outputPath: file,
          agent: yield* agents.get(ctx.agent),
          partial: aborted || expired,
        })
        output = [win.head.text, block, win.tail.text].filter((part) => part.length > 0).join("\n\n")
      }
      if (!output) output = "(no output)"

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs, maxTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              // Materialize per-instance state so disposing the instance reaps its groups.
              yield* InstanceState.get(instances)
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = Math.min(params.timeout ?? defaultTimeoutMs, maxTimeoutMs)
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  directory: instanceCtx.directory,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
