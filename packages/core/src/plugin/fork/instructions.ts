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
          Effect.map((content) => (content ? [new InstructionDiscovery.File({ path: AbsolutePath.make(file), content })] : [])),
          Effect.orElseSucceed(() => []),
        ),
      )
      snapshot.files = read.flat()
    })
    yield* refresh()
    yield* discovery.transform((editor) => snapshot.files.forEach((file) => editor.add(file)))
  }),
})
