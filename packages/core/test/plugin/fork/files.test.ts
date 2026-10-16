import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { ForkFiles } from "@opencode/core/plugin/fork/files"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../fixture/global"
import { testEffect } from "../../lib/effect"

const it = testEffect(tempGlobalLayer)

describe("fork files: goal path", () => {
  it.effect("keeps a canonical session id inside the goals directory", () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      expect(ForkFiles.goal(global, "ses_0123456789abcdef")).toBe(
        path.join(global.data, "goals", "ses_0123456789abcdef.md"),
      )
    }),
  )

  // A session id can arrive from a fetched `session import` payload, where only the `ses` prefix is
  // checked, so the path has to hold even when the id is hostile.
  it.effect("refuses a session id that would leave the goals directory", () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      expect(() => ForkFiles.goal(global, "ses_../../../../tmp/pwn")).toThrow()
      expect(() => ForkFiles.goal(global, "sub/ses_abc")).toThrow()
    }),
  )
})
