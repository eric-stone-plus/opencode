export * as ForkPdfText from "./pdf-text.js"

import { Duration, Effect } from "effect"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { collectStream } from "@opencode/util/process"

/** Characters of extracted text returned to the model. */
export const MAX_CHARS = 200_000
// One deadline covers every extractor, so a timeout cannot start the next one.
const DEADLINE = Duration.seconds(15)
const OPTIONS = { stdin: "ignore", stderr: "ignore", extendEnv: true, forceKillAfter: "1 second" } as const
const PYPDF =
  "import sys\nfrom pypdf import PdfReader\nfor page in PdfReader(sys.argv[1]).pages:\n print(page.extract_text() or '', flush=True)"
const FITZ = "import sys, fitz\nwith fitz.open(sys.argv[1]) as doc:\n for page in doc:\n  print(page.get_text(), flush=True)"

export const unreadable = (path: string) =>
  [
    `PDF has no extractable text layer: ${path}`,
    "The raw PDF is not attached to the model context. Extract text with OCR, or read a text export next to it.",
  ].join("\n")

/**
 * Text of a PDF through pdftotext, then pypdf and PyMuPDF under python3, whichever first yields any. Undefined when
 * none does. Each extractor gets its own output buffer, so a failure on a late page never mixes a partial first
 * extraction into the next one.
 */
export const extract = (spawner: ChildProcessSpawner["Service"], file: string) =>
  Effect.gen(function* () {
    for (const command of [
      ChildProcess.make("pdftotext", ["-layout", "-enc", "UTF-8", "-nopgbrk", file, "-"], OPTIONS),
      ChildProcess.make("python3", ["-c", PYPDF, file], OPTIONS),
      ChildProcess.make("python3", ["-c", FITZ, file], OPTIONS),
    ]) {
      const text = yield* attempt(spawner, command)
      if (text !== undefined) return text
    }
    return undefined
  }).pipe(Effect.timeoutOrElse({ duration: DEADLINE, orElse: () => Effect.succeed(undefined) }))

const attempt = (spawner: ChildProcessSpawner["Service"], command: ChildProcess.Command) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const [output, code] = yield* Effect.all([collectStream(handle.stdout, MAX_CHARS * 4), handle.exitCode], {
        concurrency: "unbounded",
      })
      if (code !== 0) return undefined
      const text = output.buffer.toString("utf8").replaceAll("\0", "").trim()
      if (text === "") return undefined
      return text.length > MAX_CHARS || output.truncated ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text
    }),
  ).pipe(Effect.orElseSucceed(() => undefined))
