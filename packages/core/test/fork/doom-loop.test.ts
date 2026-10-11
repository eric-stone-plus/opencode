import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Tool } from "@opencode/schema/tool"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/effect/session"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { ForkRuntimePlugin } from "@opencode/core/plugin/fork/runtime"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { ForkDoomLoop } from "@opencode/core/session/fork/doom-loop"
import { SessionMessage } from "@opencode/core/session/message"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { host } from "../plugin/host"

const sessionID = Session.ID.make("ses_doom_loop")
const other = Session.ID.make("ses_doom_loop_other")

describe("ForkDoomLoop.make", () => {
  it.effect("counts consecutive identical calls and restarts on any difference", () =>
    Effect.gen(function* () {
      const streaks = ForkDoomLoop.make()
      const record = (tool: string, input: unknown, id = "call") => streaks.record("ses_a", id, tool, input)
      expect([1, 2, 3].map(() => record("read", { path: "a.ts" }))).toEqual([1, 2, 3])
      expect(record("read", { path: "b.ts" })).toBe(1)
      expect(record("grep", { path: "b.ts" })).toBe(1)
      expect(record("grep", { path: "b.ts" })).toBe(2)
      expect(streaks.reset("ses_a")).toBe(true)
      expect(record("grep", { path: "b.ts" })).toBe(1)
    }),
  )

  it.effect("keeps sessions apart and treats a missing input as null", () =>
    Effect.gen(function* () {
      const streaks = ForkDoomLoop.make()
      expect(streaks.record("ses_a", "c1", "shell", undefined)).toBe(1)
      expect(streaks.record("ses_b", "c2", "shell", undefined)).toBe(1)
      expect(streaks.record("ses_a", "c3", "shell", null)).toBe(2)
    }),
  )

  it.effect("compares large inputs without retaining them", () =>
    Effect.gen(function* () {
      const streaks = ForkDoomLoop.make()
      const content = "x".repeat(2_000_000)
      expect(streaks.record("ses_a", "c1", "write", { content })).toBe(1)
      expect(streaks.record("ses_a", "c2", "write", { content })).toBe(2)
      expect(streaks.record("ses_a", "c3", "write", { content: `${content}y` })).toBe(1)
    }),
  )

  it.effect("ignores calls a Code Mode script makes under its execute call", () =>
    Effect.gen(function* () {
      const streaks = ForkDoomLoop.make()
      expect(streaks.record("ses_a", "outer", "execute", { code: "loop()" })).toBe(1)
      expect([1, 2, 3, 4].map(() => streaks.record("ses_a", "outer", "read", { path: "a.ts" }))).toEqual([0, 0, 0, 0])
      // The next top-level call starts from scratch and the script's calls did not interrupt the execute run.
      expect(streaks.record("ses_a", "after", "read", { path: "a.ts" })).toBe(1)
      expect(streaks.record("ses_a", "first", "execute", { code: "loop()" })).toBe(1)
      expect(streaks.record("ses_a", "second", "execute", { code: "loop()" })).toBe(2)
    }),
  )
})

type Callback<Event, Error = never> = (event: Event) => Effect.Effect<void, Error>

/** Runs the fork runtime plugin against stubbed domains, capturing its hooks and the sessions it interrupts. */
const run = Effect.fnUntraced(function* () {
  const interrupted: string[] = []
  const hooks: {
    before?: Callback<ToolHooks["execute.before"], Tool.Error>
    context?: Callback<SessionContext>
    prompt?: Callback<SessionPrompt>
  } = {}
  yield* ForkRuntimePlugin.Plugin.effect(
    host({
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: (name, callback) => {
          // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          if (name === "execute.before") hooks.before = callback as unknown as typeof hooks.before
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      session: {
        hook: (name, callback) => {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          if (name === "context") hooks.context = callback as unknown as typeof hooks.context
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          if (name === "prompt") hooks.prompt = callback as unknown as typeof hooks.prompt
          return Effect.succeed({ dispose: Effect.void })
        },
        interrupt: (input) =>
          Effect.sync(() => {
            interrupted.push(input.sessionID)
            return { interrupted: true }
          }),
      },
    }),
  )
  if (!hooks.before || !hooks.context || !hooks.prompt) return yield* Effect.die("runtime plugin hooks missing")
  const { before, context, prompt } = hooks
  return {
    interrupted,
    call: (tool: string, input: unknown, id: string, session = sessionID) =>
      before({
        tool,
        input,
        sessionID: session,
        id: Tool.CallID.make(id),
        agent: Agent.ID.make("auto"),
        messageID: SessionMessage.ID.make("msg_doom_loop"),
      }).pipe(Effect.flip, Effect.option),
    request: (session = sessionID) =>
      context({
        sessionID: session,
        agent: Agent.ID.make("auto"),
        model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
        system: [],
        messages: [Message.user("continue")],
        tools: {},
        options: {},
      }),
    prompt: (session = sessionID) =>
      prompt({
        sessionID: session,
        messageID: SessionMessage.ID.make("msg_doom_prompt"),
        prompt: { text: "next" },
        delivery: "steer",
      }),
  }
})

describe("fork runtime plugin doom-loop guard", () => {
  it.effect("lets two identical calls through and refuses every later one with the steering message", () =>
    Effect.gen(function* () {
      const { call } = yield* run()
      const results = []
      for (const index of [1, 2, 3, 4, 5]) results.push(yield* call("read", { path: "a.ts" }, `call_${index}`))
      expect(results[0]?._tag).toBe("None")
      expect(results[1]?._tag).toBe("None")
      const third = results[2]
      expect(third?._tag).toBe("Some")
      if (third?._tag !== "Some") return
      expect(third.value).toBeInstanceOf(Tool.Error)
      expect(third.value.message).toBe(ForkDoomLoop.message("read", 3))
      expect(third.value.message).toContain("identical input 3 times in a row, so this call was not executed")
      expect(third.value.message).toContain("the run will be stopped")
      expect(results.slice(2).every((result) => result._tag === "Some")).toBe(true)
    }),
  )

  it.effect("stops the run at the next model request after the sixth identical call, once", () =>
    Effect.gen(function* () {
      const { call, request, interrupted } = yield* run()
      for (const index of [1, 2, 3, 4, 5]) yield* call("read", { path: "a.ts" }, `call_${index}`)
      // Five identical calls have not stopped anything.
      yield* request()
      expect(interrupted).toEqual([])

      const sixth = yield* call("read", { path: "a.ts" }, "call_6")
      expect(sixth._tag === "Some" && sixth.value.message).toBe(ForkDoomLoop.message("read", 6))
      expect(sixth._tag === "Some" && sixth.value.message).toContain("the run is being stopped")
      // The refusal is recorded first; the stop only lands when the runner prepares its next request.
      expect(interrupted).toEqual([])
      yield* request()
      expect(interrupted).toEqual([sessionID])
      yield* request()
      expect(interrupted).toEqual([sessionID])
    }),
  )

  it.effect("starts counting again after a different call", () =>
    Effect.gen(function* () {
      const { call } = yield* run()
      yield* call("read", { path: "a.ts" }, "call_1")
      yield* call("read", { path: "a.ts" }, "call_2")
      yield* call("shell", { command: "ls" }, "call_3")
      const again = yield* call("read", { path: "a.ts" }, "call_4")
      expect(again._tag).toBe("None")
    }),
  )

  it.effect("starts a new run of calls with each user prompt and cancels a pending stop", () =>
    Effect.gen(function* () {
      const { call, request, prompt, interrupted } = yield* run()
      for (const index of [1, 2, 3, 4, 5, 6]) yield* call("read", { path: "a.ts" }, `call_${index}`)
      yield* prompt()
      yield* request()
      expect(interrupted).toEqual([])
      expect((yield* call("read", { path: "a.ts" }, "call_7"))._tag).toBe("None")
    }),
  )

  it.effect("counts sessions independently and only interrupts the looping one", () =>
    Effect.gen(function* () {
      const { call, request, interrupted } = yield* run()
      for (const index of [1, 2, 3, 4, 5, 6]) yield* call("read", { path: "a.ts" }, `call_${index}`)
      expect((yield* call("read", { path: "a.ts" }, "other_1", other))._tag).toBe("None")
      yield* request(other)
      expect(interrupted).toEqual([])
      yield* request()
      expect(interrupted).toEqual([sessionID])
    }),
  )

  it.effect("does not count the calls inside a Code Mode script", () =>
    Effect.gen(function* () {
      const { call } = yield* run()
      yield* call("execute", { code: "for (;;) await tools.read({ path: 'a.ts' })" }, "outer")
      const nested = []
      for (let index = 0; index < 8; index++) nested.push(yield* call("read", { path: "a.ts" }, "outer"))
      expect(nested.every((result) => result._tag === "None")).toBe(true)
    }),
  )
})
