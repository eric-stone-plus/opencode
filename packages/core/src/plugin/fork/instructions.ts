export * as ForkInstructionsPlugin from "./instructions.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import path from "path"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

// Injection budget (borrow C27). codewhale caps memory injection at 32 entries / 12000 bytes and
// labels what it injects with an authority envelope; this is that pattern transplanted to the fork's
// instruction sources: a bounded number of files, a bounded size per file, a logged count of dropped
// files, and an inline marker where a file is truncated. The authority label does not carry over:
// instruction files are user-authored, the same principal as the config that lists them, and labeling
// the user's own text untrusted would be noise.
export const MAX_INSTRUCTION_FILES = 32
export const MAX_INSTRUCTION_BYTES = 12_000

export type InstructionSource = { path: string; content: string }

export function applyInstructionBudget(sources: InstructionSource[]): {
  files: InstructionSource[]
  dropped: number
  truncated: number
} {
  const admitted = sources.slice(0, MAX_INSTRUCTION_FILES)
  let truncated = 0
  const files = admitted.map((source) => {
    if (Buffer.byteLength(source.content, "utf8") <= MAX_INSTRUCTION_BYTES) return source
    truncated++
    return { ...source, content: capContent(source.content) }
  })
  return { files, dropped: sources.length - admitted.length, truncated }
}

// Cut on a character boundary so the marker is never preceded by half a code point.
function capContent(content: string): string {
  const size = Buffer.byteLength(content, "utf8")
  const head = Buffer.from(content, "utf8").subarray(0, MAX_INSTRUCTION_BYTES).toString("utf8").replace(/\uFFFD+$/, "")
  return `${head}\n\n[... ${size - Buffer.byteLength(head, "utf8")} bytes omitted: instruction budget]`
}

/**
 * The `instructions` config array has no upstream consumer. Entries are local files or globs: `~/` expands to the
 * home directory, an absolute entry globs its basename inside its directory, and a relative one is searched upward
 * from the location to the project root. URLs are not fetched.
 */
export const Plugin = define({
  id: "fork.instructions",
  effect: Effect.fn("ForkInstructionsPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const loaded: { entries: Entry[] } = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      Effect.suspend(() => refresh().pipe(Effect.andThen(discovery.reload()))),
    )
    // Unreadable files drop out of this snapshot and so out of the model context until they read again.
    const snapshot: { files: InstructionDiscovery.File[] } = { files: [] }

    const resolve = (entry: string) => {
      if (/^https?:\/\//.test(entry)) return Effect.logWarning("remote instructions are not supported", { entry }).pipe(Effect.as([]))
      const expanded = entry.startsWith("~/") ? path.join(global.home, entry.slice(2)) : entry
      const found = path.isAbsolute(expanded)
        ? fs.scan(path.basename(expanded), { cwd: path.dirname(expanded), absolute: true, include: "file", dot: true })
        : fs.globUp(expanded, location.directory, location.project.directory)
      return found.pipe(Effect.orElseSucceed(() => [] as string[]))
    }

    // The explicit type breaks the inference cycle with `loaded`, whose reload callback runs this.
    const refresh: () => Effect.Effect<void> = Effect.fn("ForkInstructionsPlugin.refresh")(function* () {
      const entries = loaded.entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : []))
      const paths = [...new Set((yield* Effect.forEach([...new Set(entries)], resolve)).flat().map((file) => path.resolve(file)))]
      const read = yield* Effect.forEach(paths, (file) =>
        fs.readFileStringSafe(file).pipe(
          Effect.map((content): InstructionSource[] => (content ? [{ path: file, content }] : [])),
          Effect.orElseSucceed(() => [] as InstructionSource[]),
        ),
      )
      const budget = applyInstructionBudget(read.flat())
      if (budget.dropped > 0 || budget.truncated > 0)
        yield* Effect.logWarning("instruction budget applied", { dropped: budget.dropped, truncated: budget.truncated })
      snapshot.files = budget.files.map(
        (source) => new InstructionDiscovery.File({ path: AbsolutePath.make(source.path), content: source.content }),
      )
    })
    yield* refresh()
    yield* discovery.transform((editor) => snapshot.files.forEach((file) => editor.add(file)))
  }),
})
