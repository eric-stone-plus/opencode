// Stopping a subagent the model started (borrow C9). These tests pin the ownership rule and the spawn
// wrapper: a plain spawn is untouched, an owned child is interrupted and its job cancelled, and a
// foreign or unknown session is refused without the interrupt call ever being made.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import type { Tool } from "@opencode/schema/tool"
import { Job } from "@opencode/core/job"
import { SessionSchema } from "@opencode/core/session/schema"
import { ForkSubagentInterruptPlugin, interruptable } from "@opencode/core/plugin/fork/interrupt"
import { definition } from "@opencode/core/tool/runtime"
import { it } from "../../lib/effect"
import { host } from "../host"

const parent = SessionSchema.ID.make("ses_parent")
const child = SessionSchema.ID.make("ses_child")
const stranger = SessionSchema.ID.make("ses_stranger")

describe("interruptable", () => {
  test("allows a session's own child and nothing else", () => {
    expect(interruptable({ parentID: parent }, parent)).toBe(true)
    expect(interruptable({ parentID: stranger }, parent)).toBe(false)
    expect(interruptable({}, parent)).toBe(false)
    expect(interruptable(undefined, parent)).toBe(false)
  })
})

type SpawnInput = { readonly prompt?: string; readonly sessionID?: SessionSchema.ID; readonly interrupt?: boolean }

/** Runs the plugin against a captured subagent tool and stubbed session and job services. */
const setup = Effect.fnUntraced(function* (input: {
  sessions: Record<string, { readonly parentID?: SessionSchema.ID }>
  interrupted?: boolean
}) {
  const spawns: SpawnInput[] = []
  const calls = { interrupted: [] as string[], cancelled: [] as string[] }
  const tool: Tool.Info = {
    name: "subagent",
    description: "",
    input: Schema.Struct({ prompt: Schema.String }),
    execute: (value: SpawnInput) =>
      Effect.sync(() => {
        spawns.push(value)
        return { output: { sessionID: child, status: "running" as const, output: "started" } }
      }),
  }
  const jobs = Layer.succeed(Job.Service, {
    cancel: (id: string) =>
      Effect.sync(() => {
        calls.cancelled.push(id)
        return undefined
      }),
    get: () => Effect.succeed(undefined),
    start: () => Effect.die("unused job.start"),
    wait: () => Effect.die("unused job.wait"),
    block: () => Effect.die("unused job.block"),
    background: () => Effect.die("unused job.background"),
    backgroundAll: () => Effect.die("unused job.backgroundAll"),
    pendingBackground: Effect.die("unused job.pendingBackground"),
    completeBackground: () => Effect.die("unused job.completeBackground"),
  })
  yield* ForkSubagentInterruptPlugin.Plugin.effect(
    host({
      session: {
        get: ({ sessionID }: { sessionID: SessionSchema.ID }) => {
          const found = input.sessions[sessionID]
          return found === undefined ? Effect.die(`no session ${sessionID}`) : Effect.succeed(found as never)
        },
        interrupt: ({ sessionID }: { sessionID: SessionSchema.ID }) =>
          Effect.sync(() => {
            calls.interrupted.push(sessionID)
            return { interrupted: input.interrupted ?? true }
          }),
      } as never,
      tool: {
        transform: (transform: (editor: unknown) => void) =>
          Effect.sync(() =>
            transform({
              add: () => {},
              remove: () => {},
              update: (_id: string, update: (tool: never) => void) => update(tool as never),
            }),
          ),
        hook: () => Effect.die("unused tool.hook"),
        list: () => Effect.die("unused tool.list"),
        get: () => Effect.die("unused tool.get"),
        execute: () => Effect.die("unused tool.execute"),
      } as never,
    }),
  ).pipe(Effect.provide(jobs))

  const call = (value: SpawnInput) => {
    const context = {
      sessionID: parent,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      progress: () => Effect.void,
    } as unknown as Tool.Context
    return tool.execute(value, context).pipe(Effect.exit)
  }
  return { tool, call, spawns, calls }
})

describe("fork subagent interrupt: the spawn wrapper", () => {
  it.effect("exposes interrupt on the spawn schema and leaves the original fields required", () =>
    Effect.gen(function* () {
      const { tool } = yield* setup({ sessions: {} })
      const schema = definition(tool).inputSchema as {
        readonly properties?: Record<string, unknown>
        readonly required?: ReadonlyArray<string>
      }
      expect(Object.keys(schema.properties ?? {})).toContain("interrupt")
      expect(schema.required ?? []).toContain("prompt")
      expect(schema.required ?? []).not.toContain("interrupt")
    }),
  )

  it.effect("delegates a plain spawn untouched", () =>
    Effect.gen(function* () {
      const { call, spawns, calls } = yield* setup({ sessions: {} })
      expect(Exit.isSuccess(yield* call({ prompt: "work" }))).toBe(true)
      expect(spawns).toHaveLength(1)
      expect(calls.interrupted).toEqual([])
      expect(calls.cancelled).toEqual([])
    }),
  )

  it.effect("stops an owned child and cancels its job", () =>
    Effect.gen(function* () {
      const { call, spawns, calls } = yield* setup({ sessions: { [child]: { parentID: parent } } })
      const result = yield* call({ sessionID: child, interrupt: true })
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) {
        const output = (result.value.output as { readonly output: string }).output
        expect(output).toContain(`Interrupted subagent ${child}`)
      }
      // No child was started, and both halves of the stop happened.
      expect(spawns).toHaveLength(0)
      expect(calls.interrupted).toEqual([child])
      expect(calls.cancelled).toEqual([child])
    }),
  )

  it.effect("says so when the child was not running", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ sessions: { [child]: { parentID: parent } }, interrupted: false })
      const result = yield* call({ sessionID: child, interrupt: true })
      if (Exit.isSuccess(result))
        expect((result.value.output as { readonly output: string }).output).toContain("was not running")
    }),
  )

  it.effect("refuses a foreign session without touching it", () =>
    Effect.gen(function* () {
      const foreign = yield* setup({ sessions: { [stranger]: { parentID: SessionSchema.ID.make("ses_other") } } })
      const refused = yield* foreign.call({ sessionID: stranger, interrupt: true })
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(refused.cause.toString()).toContain("No subagent of this session")
      expect(foreign.calls.interrupted).toEqual([])
      expect(foreign.calls.cancelled).toEqual([])

      // An unknown session is refused the same way: nothing to stop, nothing to leak.
      const unknown = yield* setup({ sessions: {} })
      expect(Exit.isFailure(yield* unknown.call({ sessionID: stranger, interrupt: true }))).toBe(true)
      expect(unknown.calls.interrupted).toEqual([])
    }),
  )

  it.effect("refuses an interrupt with no session to stop", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({ sessions: {} })
      const refused = yield* call({ interrupt: true })
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(refused.cause.toString()).toContain("requires the sessionID")
      expect(calls.interrupted).toEqual([])
    }),
  )
})
