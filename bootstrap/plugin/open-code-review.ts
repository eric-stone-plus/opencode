// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Vendored single-file OpenCode integration for OpenCodeReview (ocr).
// Provenance: alibaba/open-code-review
//   plugins/open-code-review/opencode/open-code-review.ts
//   @182898cf522da3d04157b422752d028417974e19 (fetched 2026-10-07)
// Local modifications (kept minimal, see git history of bootstrap/plugin/):
//   1. install-error hint also matches bun's spawn error shape
//      ("Executable not found in $PATH"), not just "ENOENT".
//   2. explicit `repo` tool argument on ocr_review/ocr_health: the session
//      working directory may live outside the repository (e.g. workspace root
//      `/`), and OCR requires cwd inside a git repo.
//   3. a "not a git repository" failure now tells the caller to pass `repo`.
// Upstream ships its tests alongside
// (test/open-code-review.test.mjs, 36 cases): run `npm install && npm run
// check` in a scratch copy of plugins/open-code-review/opencode/ before
// re-vendoring a newer revision.
//
// V2 port 2026-10-12: the V1-API half is gone. `server` and its `tool({ args })`
// zod builders became `ctx.tool.transform` registrations of plain JSON schemas,
// its `config` command hook became the `ctx.command.transform` registration
// below (which never overrides a command the user already defined, like the V1
// `??=` guards), and the runtime `@opencode-ai/plugin` import went with them.
// Cancellation is `tool.signal` (V1 `context.abort`, with the 3 s SIGKILL
// fallback); the repo default is the plugin-level `ctx.location.directory`,
// because the V2 tool context carries neither `worktree` nor `directory`.
//
// Deploy target: ~/.config/opencode/plugin/open-code-review.ts, copied from
// bootstrap/plugin/. The V2 loader reads this single default export
// (`id` + `setup`); install.sh/verify.sh still name only
// {block-unsafe-kill,secret-path-guard,local-tools}.ts, so this file is not in
// those loops yet.
//
// Runtime imports: node builtins + type-only plugin imports, so the file loads
// standalone in script/open-code-review.test.ts.

import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"

// Retry cleanup long enough for transient file locks, such as antivirus scans, to clear.
const backgroundCleanupMaxRetries = 20
const backgroundCleanupRetryDelayMs = 50

interface ReviewInput {
  repo?: string
  commit?: string
  from?: string
  to?: string
  resume?: string
  background?: string
  backgroundFile?: string
  exclude?: string
  model?: string
  concurrency?: number
  timeoutMinutes?: number
  overallTimeoutMinutes?: number
  maxTools?: number
  maxGitProcesses?: number
  preview?: boolean
}

interface OcrInvocation {
  command: string
  prefixArgs: string[]
}

interface RunOptions {
  cwd: string
  timeoutMs?: number | null
  maxOutputBytes?: number
  invocation?: OcrInvocation
  signal?: AbortSignal
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

class OcrExecutionError extends Error {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string

  constructor(message: string, result: {
    exitCode: number | null
    signal?: NodeJS.Signals | null
    stderr?: string
    stdout?: string
  }) {
    super(message)
    this.name = "OcrExecutionError"
    this.exitCode = result.exitCode
    this.signal = result.signal ?? null
    this.stderr = result.stderr ?? ""
    this.stdout = result.stdout ?? ""
  }
}

function pushValue(args: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined && value !== "") {
    args.push(flag, String(value))
  }
}

export function buildReviewArgs(input: ReviewInput, repo: string, backgroundFile?: string): string[] {
  const hasRange = input.from !== undefined || input.to !== undefined
  if (hasRange && (!input.from || !input.to)) {
    throw new Error("Both 'from' and 'to' are required for a branch comparison.")
  }
  if (input.commit && hasRange) {
    throw new Error("Use either 'commit' or a 'from'/'to' range, not both.")
  }
  if (input.resume && (input.commit || hasRange)) {
    throw new Error("'resume' cannot be combined with 'commit' or a 'from'/'to' range.")
  }
  if (input.preview && input.resume) {
    throw new Error("'preview' and 'resume' cannot be used together.")
  }
  // OCR warns on stderr and lets the file win, but formatReviewResult drops
  // stderr on exit 0, so the caller would never see it.
  if (input.background && input.backgroundFile) {
    throw new Error("Use either 'background' or 'backgroundFile', not both.")
  }

  const args = ["review", "--audience", "agent"]
  if (!input.preview) {
    args.push("--format", "json")
  }
  args.push("--repo", repo)

  pushValue(args, "--commit", input.commit)
  pushValue(args, "--from", input.from)
  pushValue(args, "--to", input.to)
  pushValue(args, "--resume", input.resume)
  if (backgroundFile !== undefined) {
    pushValue(args, "--background-file", backgroundFile)
  } else {
    pushValue(args, "--background", input.background)
    pushValue(args, "--background-file", input.backgroundFile)
  }
  pushValue(args, "--exclude", input.exclude)
  pushValue(args, "--model", input.model)
  pushValue(args, "--concurrency", input.concurrency)
  pushValue(args, "--timeout", input.timeoutMinutes)
  pushValue(args, "--max-tools", input.maxTools)
  pushValue(args, "--max-git-procs", input.maxGitProcesses)

  if (input.preview) {
    args.push("--preview")
  }
  return args
}

async function withTemporaryBackgroundFile<T>(
  background: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ocr-opencode-background-"))
  try {
    if (process.platform !== "win32") {
      await chmod(directory, 0o700)
    }
    const path = join(directory, "background.md")
    await writeFile(path, background, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    return await callback(path)
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: backgroundCleanupMaxRetries,
      retryDelay: backgroundCleanupRetryDelayMs,
    })
  }
}

function appendChunk(
  chunks: Uint8Array[],
  currentBytes: number,
  chunk: Uint8Array,
  maxBytes: number,
): number {
  const nextBytes = currentBytes + chunk.byteLength
  if (nextBytes > maxBytes) {
    throw new Error(`OCR output exceeded the ${maxBytes}-byte safety limit.`)
  }
  chunks.push(chunk)
  return nextBytes
}

export async function runOcr(args: string[], options: RunOptions): Promise<RunResult> {
  const invocation = options.invocation ?? { command: "ocr", prefixArgs: [] }
  const timeoutMs = options.timeoutMs === undefined ? 15 * 60 * 1000 : options.timeoutMs
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(
      invocation.command,
      [...invocation.prefixArgs, ...args],
      {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        detached: true,
      },
    )
    child.stdin.end()

    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let outputBytes = 0
    let settled = false
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abort) {
        options.signal?.removeEventListener("abort", abort)
      }
      callback()
    }

    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (closed || child.pid === undefined) return
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
        return
      }
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }

    const terminateChild = (): void => {
      if (closed) return
      killProcessGroup("SIGTERM")
      forceKillTimer ??= setTimeout(() => {
        if (!closed) {
          killProcessGroup("SIGKILL")
        }
      }, 3_000)
    }

    const failForOutputLimit = (error: Error): void => {
      terminateChild()
      finish(() => reject(error))
    }

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        outputBytes = appendChunk(stdoutChunks, outputBytes, chunk, maxOutputBytes)
      } catch (error) {
        failForOutputLimit(error as Error)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        outputBytes = appendChunk(stderrChunks, outputBytes, chunk, maxOutputBytes)
      } catch (error) {
        failForOutputLimit(error as Error)
      }
    })

    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || error.message.includes("ENOENT") || error.message.includes("not found in")
      const message = missing
        ? "OpenCodeReview is not installed or 'ocr' is not on PATH. Install it with: npm install -g @alibaba-group/open-code-review"
        : `Failed to start OpenCodeReview: ${error.message}`
      finish(() => reject(new OcrExecutionError(message, { exitCode: null })))
    })

    child.on("close", (exitCode, signal) => {
      closed = true
      clearTimeout(forceKillTimer)
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim()
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
        if (exitCode === 0) {
          resolve({ stdout, stderr, exitCode, signal: signal ?? null })
          return
        }
        // A signal kill reports a null exit code. Naming the signal keeps it
        // distinguishable from a genuine exit 1 when OCR wrote no output.
        // `?? 1` keeps the message numeric: close always reports one of the
        // two, but neither is typed as non-null.
        const cause = signal
          ? `was terminated by signal ${signal}`
          : `exited with code ${exitCode ?? 1}`
        const detail = stderr || stdout || `OpenCodeReview ${cause}.`
        const hint = /not a git repository/i.test(detail)
          ? " Hint: pass the repository path via the 'repo' tool argument — the session working directory is not inside a git repository."
          : ""
        reject(new OcrExecutionError(
          detail + hint,
          { exitCode, signal, stdout, stderr },
        ))
      })
    })

    abort = (): void => {
      terminateChild()
      finish(() => reject(new OcrExecutionError(
        "OpenCodeReview was cancelled by OpenCode.",
        {
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        },
      )))
    }
    options.signal?.addEventListener("abort", abort, { once: true })

    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        terminateChild()
        finish(() => reject(new OcrExecutionError(
          `OpenCodeReview timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          {
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          },
        )))
      }, timeoutMs)
    }

    if (options.signal?.aborted) {
      abort()
    }
  })
}

function formatReviewResult(result: RunResult, preview: boolean): string {
  if (preview) {
    return result.stdout || "No files changed."
  }
  if (result.stdout === "") {
    return "No changes detected; OCR produced no output."
  }
  try {
    JSON.parse(result.stdout)
    return result.stdout
  } catch {
    throw new OcrExecutionError("OpenCodeReview returned invalid JSON.", result)
  }
}

// OCR requires cwd inside the target git repository. The plugin location
// directory is only a default — when it sits outside the repo (workspace root
// `/`, home-directory sessions), the caller passes the repo explicitly.
export function resolveRepoDir(base: string, repo: string | undefined): string {
  if (repo === undefined || repo === "") return base
  return resolve(base, repo)
}

const REPO_ARG_DESCRIPTION =
  "Path to the git repository to review. Defaults to the session working directory. " +
  "Required when the session directory is not inside the repository (OCR needs cwd in a git repo)."

const OCR_REVIEW_DESCRIPTION =
  "Run OpenCodeReview on workspace changes, one commit, or a ref range. " +
  "Returns structured line-level findings as JSON. Use preview=true to inspect scope without LLM usage. " +
  "Pass repo when the session directory is not inside the target git repository."

const OCR_HEALTH_DESCRIPTION =
  "Check the installed OpenCodeReview version and verify its configured LLM connection."

const OCR_REVIEW_COMMAND_TEMPLATE =
  "Use the ocr_review tool to review the requested target. " +
  "Treat the following text as review intent, target details, and business context:"

const OCR_REVIEW_COMMAND_SUFFIX =
  ". If no target is specified, review the current workspace changes. " +
  "Report findings by severity with exact file and line references."

const OCR_HEALTH_COMMAND_TEMPLATE =
  "Use the ocr_health tool and explain any configuration problem concisely."

export default {
  id: "open-code-review",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ocr_review",
        options: { codemode: false },
        description: OCR_REVIEW_DESCRIPTION,
        // The V1 `tool({ args: reviewArgs })` schema, argument for argument.
        input: {
          type: "object",
          properties: {
            repo: { type: "string", description: REPO_ARG_DESCRIPTION },
            commit: { type: "string", description: "Review one commit against its parent." },
            from: { type: "string", description: "Base ref for a branch/range comparison. Must be paired with 'to'." },
            to: { type: "string", description: "Target ref for a branch/range comparison. Must be paired with 'from'." },
            resume: { type: "string", description: "Resume a previous OCR review session by ID." },
            background: { type: "string", description: "Business or requirement context that the implementation should satisfy." },
            backgroundFile: { type: "string", description: "Path to a Markdown file holding the review background, for context too long to pass inline. A relative path resolves against the repository root; an absolute path is used as given. Cannot be combined with 'background'." },
            exclude: { type: "string", description: "Comma-separated gitignore-style exclusion patterns." },
            model: { type: "string", description: "Override the model configured in OpenCodeReview." },
            concurrency: { type: "integer", minimum: 1, description: "Maximum concurrent file reviews." },
            timeoutMinutes: { type: "integer", minimum: 1, description: "Per-file OCR timeout in minutes." },
            overallTimeoutMinutes: { type: "integer", minimum: 1, description: "Optional wall-clock timeout for the complete OCR process in minutes." },
            maxTools: { type: "integer", minimum: 1, description: "Maximum tool-call rounds per subtask; OCR enforces a minimum of 50." },
            maxGitProcesses: { type: "integer", minimum: 1, description: "Maximum concurrent Git subprocesses." },
            preview: { type: "boolean", description: "List the files that would be reviewed without calling an LLM." },
          },
          required: [],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const review = input as ReviewInput
          const { background, ...inputWithoutBackground } = review
          const normalizedBackground = background?.trim()
          const normalized: ReviewInput = normalizedBackground
            ? { ...inputWithoutBackground, background: normalizedBackground }
            : inputWithoutBackground
          const cwd = resolveRepoDir(ctx.location.directory, normalized.repo)
          const options: RunOptions = {
            cwd,
            signal: tool.signal,
            timeoutMs: normalized.overallTimeoutMinutes !== undefined
              ? normalized.overallTimeoutMinutes * 60 * 1000
              : 30 * 60 * 1000,
          }
          const runReview = async (backgroundFile?: string): Promise<string> => {
            const result = await runOcr(buildReviewArgs(normalized, cwd, backgroundFile), options)
            return formatReviewResult(result, normalized.preview === true)
          }
          // Inline background goes through an 0600 temp file that the finally
          // path removes; OCR prefers it over `--background`.
          const content = normalized.background !== undefined
            ? await withTemporaryBackgroundFile(normalized.background, runReview)
            : await runReview()
          return { content }
        },
      })

      editor.add({
        name: "ocr_health",
        options: { codemode: false },
        description: OCR_HEALTH_DESCRIPTION,
        input: {
          type: "object",
          properties: { repo: { type: "string", description: REPO_ARG_DESCRIPTION } },
          required: [],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const cwd = resolveRepoDir(ctx.location.directory, (input as { repo?: string }).repo)
          const [version, llm] = await Promise.allSettled([
            runOcr(["version"], { cwd, timeoutMs: 30_000, signal: tool.signal }),
            runOcr(["llm", "test"], { cwd, timeoutMs: 60_000, signal: tool.signal }),
          ])
          const rejected = [version, llm].find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          )
          // A cancelled call stays a cancellation instead of a "check failed"
          // line the model would try to explain.
          if (tool.signal.aborted && rejected) {
            throw rejected.reason
          }

          const parts: string[] = []
          if (version.status === "fulfilled") {
            parts.push(version.value.stdout)
          } else {
            parts.push(`Version check failed: ${version.reason?.message ?? "unknown error"}`)
          }
          if (llm.status === "fulfilled") {
            parts.push(llm.value.stdout, llm.value.stderr)
          } else {
            parts.push(`LLM connection check failed: ${llm.reason?.message ?? "unknown error"}`)
          }
          return { content: parts.filter(Boolean).join("\n") }
        },
      })
    })

    // Like the V1 `??=` guards above, never override commands the user
    // already defined under the same names.
    const registeredCommands = await ctx.command.list()
    const commandNames = new Set(registeredCommands.data.map((command) => command.name))

    await ctx.command.transform((editor) => {
      // Text-only prompts, matching the V1 $ARGUMENTS templates: spreading the
      // incoming prompt attachments would violate exactOptionalPropertyTypes
      // and risk stale attachment offsets after the text rewrite.
      if (!commandNames.has("ocr-review")) {
        editor.add({
          name: "ocr-review",
          description: "Review code changes with OpenCodeReview",
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              sessionID,
              text: `${OCR_REVIEW_COMMAND_TEMPLATE}${prompt.text ?? ""}${OCR_REVIEW_COMMAND_SUFFIX}`,
              delivery,
            })
          },
        })
      }
      if (!commandNames.has("ocr-health")) {
        editor.add({
          name: "ocr-health",
          description: "Check OpenCodeReview and its LLM connection",
          execute: async ({ sessionID, delivery }) => {
            await ctx.session.prompt({
              sessionID,
              text: OCR_HEALTH_COMMAND_TEMPLATE,
              delivery,
            })
          },
        })
      }
    })
  },
} satisfies Plugin.Plugin
