import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

// Default truncation limits. Overridden per instance by the opencode config keys
// `tool_output.max_lines` and `tool_output.max_bytes` (see `limits()` and the
// `tool_output` schema in @opencode-ai/core v1/config). Defaults are deliberately
// small: truncation shape (head+tail windowing), not bigger context dumps, is the
// mitigation for large outputs.
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  /**
   * Which end(s) of the output to keep when truncating. "both" (the default) keeps a
   * head window and a tail window with an elision marker between them; "head"/"tail"
   * keep a single end and use the full budget there.
   */
  direction?: "head" | "tail" | "both"
}

/** A contiguous slice of the output plus how many complete source lines it shows. */
export type Slice = { text: string; lines: number; bytes: number }

export type Window = {
  head: Slice
  tail: Slice
  elidedLines: number
  elidedBytes: number
  cut: boolean
}

// Share of the line/byte budget given to the head window; the tail gets the rest.
const HEAD_SHARE = 0.7

function budgets(maxLines: number, maxBytes: number) {
  const headLines = Math.min(maxLines, Math.max(1, Math.floor(maxLines * HEAD_SHARE)))
  const headBytes = Math.min(maxBytes, Math.max(1, Math.floor(maxBytes * HEAD_SHARE)))
  return {
    headLines,
    headBytes,
    tailLines: Math.max(0, maxLines - headLines),
    tailBytes: Math.max(0, maxBytes - headBytes),
  }
}

/**
 * Longest prefix of `text` within the line/byte budget. Prefers whole lines; falls
 * back to a utf-8-safe byte prefix only when the first line alone exceeds the budget.
 * `lines` counts only complete source lines shown.
 */
export function takeHead(text: string, maxLines: number, maxBytes: number): Slice {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let end = Math.min(buf.length, maxBytes)
        while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
        return { text: buf.subarray(0, end).toString("utf-8"), lines: 0, bytes: end }
      }
      break
    }
    out.push(lines[i])
    bytes += size
  }
  const joined = out.join("\n")
  return { text: joined, lines: out.length, bytes: Buffer.byteLength(joined, "utf-8") }
}

/**
 * Longest suffix of `text` within the line/byte budget (mirror of takeHead).
 * `firstLinePartial` marks sources that start mid-line (a remainder or a dropped
 * middle): that fragment never counts as a complete line.
 */
export function takeTail(text: string, maxLines: number, maxBytes: number, firstLinePartial = false): Slice {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  let tookFirst = false
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        return { text: buf.subarray(start).toString("utf-8"), lines: 0, bytes: buf.length - start }
      }
      break
    }
    out.unshift(lines[i])
    if (i === 0) tookFirst = true
    bytes += size
  }
  const joined = out.join("\n")
  const shown = out.length - (firstLinePartial && tookFirst ? 1 : 0)
  return { text: joined, lines: shown, bytes: Buffer.byteLength(joined, "utf-8") }
}

/**
 * Head+tail window of one contiguous text: keeps ~70% of the line/byte budget at the
 * start and the rest at the end, reporting exactly how much is elided in between.
 */
export function windowText(text: string, maxLines: number, maxBytes: number): Window {
  const totalLines = text.split("\n").length
  const totalBytes = Buffer.byteLength(text, "utf-8")
  const budget = budgets(maxLines, maxBytes)
  const head = takeHead(text, budget.headLines, budget.headBytes)
  const rest = text.slice(head.text.length)
  const tail = takeTail(rest, budget.tailLines, budget.tailBytes, head.text.length > 0)
  return finish(head, tail, totalLines, totalBytes)
}

/**
 * Head+tail window over a source that was already split (shell streaming keeps the
 * true head and tail chunks and drops the middle): `tailSource` is a suffix of the
 * original output and may start mid-line (`tailStartsMidLine`).
 */
export function windowParts(
  headSource: string,
  tailSource: string,
  totals: { lines: number; bytes: number },
  maxLines: number,
  maxBytes: number,
  tailStartsMidLine = false,
): Window {
  const budget = budgets(maxLines, maxBytes)
  const head = takeHead(headSource, budget.headLines, budget.headBytes)
  const tail = takeTail(tailSource, budget.tailLines, budget.tailBytes, tailStartsMidLine)
  return finish(head, tail, totals.lines, totals.bytes)
}

function finish(head: Slice, tail: Slice, totalLines: number, totalBytes: number): Window {
  const elidedLines = totalLines - head.lines - tail.lines
  const elidedBytes = totalBytes - head.bytes - tail.bytes
  return { head, tail, elidedLines, elidedBytes, cut: elidedLines > 0 || elidedBytes > 0 }
}

/**
 * One compact marker block: exact elided counts, the spill file path, and a concrete
 * re-read recipe (Read with offset/limit, or Grep on the spill file).
 */
export function marker(params: {
  elidedLines: number
  elidedBytes: number
  outputPath: string
  /**
   * Calling agent: decides the re-read recipe. Derived here (not passed in) so every
   * marker call site — Truncate.output and ShellTool — shows the same recipe for the
   * same agent, instead of each computing `delegate` its own way.
   */
  agent?: Agent.Info
  /**
   * Set when the producing run was aborted or timed out: output still in flight at
   * that point may never have reached the spill file, so the marker must not claim
   * the saved copy is full.
   */
  partial?: boolean
}) {
  const lines = `${params.elidedLines} ${params.elidedLines === 1 ? "line" : "lines"}`
  const bytes = `${params.elidedBytes} ${params.elidedBytes === 1 ? "byte" : "bytes"}`
  const saved = params.partial ? "Partial output saved to" : "Full output saved to"
  const header = `The tool call succeeded but the output was truncated: elided ${lines} / ${bytes}. ${saved}: ${params.outputPath}`
  const recipe = hasTaskTool(params.agent)
    ? `To inspect the elided portion: delegate to the Task tool to Grep and Read ${params.outputPath} with offset/limit. Do NOT read the full file yourself - delegate to save context.`
    : `To inspect the elided portion: Read ${params.outputPath} with offset/limit, or Grep ${params.outputPath} for keywords.`
  return `${header}\n${recipe}`
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full
   * text to the truncation directory and returns a head+tail preview (per `direction`)
   * with an elision marker stating the exact dropped counts and how to re-read the file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config
   * (`tool_output.max_lines` / `tool_output.max_bytes`), or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "both"
      const totalLines = text.split("\n").length
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      let head = ""
      let tail = ""
      let elidedLines = 0
      let elidedBytes = 0
      if (direction === "head") {
        const slice = takeHead(text, maxLines, maxBytes)
        head = slice.text
        elidedLines = totalLines - slice.lines
        elidedBytes = totalBytes - slice.bytes
      } else if (direction === "tail") {
        const slice = takeTail(text, maxLines, maxBytes)
        tail = slice.text
        elidedLines = totalLines - slice.lines
        elidedBytes = totalBytes - slice.bytes
      } else {
        const win = windowText(text, maxLines, maxBytes)
        head = win.head.text
        tail = win.tail.text
        elidedLines = win.elidedLines
        elidedBytes = win.elidedBytes
      }

      const file = yield* write(text)
      const block = marker({ elidedLines, elidedBytes, outputPath: file, agent })
      const content = [head, block, tail].filter((part) => part.length > 0).join("\n\n")

      return {
        content,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Truncate from "./truncate"
