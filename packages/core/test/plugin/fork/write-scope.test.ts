// Declared write scopes for sibling subagents (borrow C33). These tests pin both halves: the pure
// overlap rule (a directory boundary, not a string prefix) and the spawn wrapper - a declared spawn
// that clashes with a live sibling is refused, the claim binds to the child session the tool reports
// after create, and the claim dies with the child's job.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import type { Tool } from "@opencode/schema/tool"
import { Job } from "@opencode/core/job"
import { definition } from "@opencode/core/tool/runtime"
import { SessionSchema } from "@opencode/core/session/schema"
import { ForkWriteScopePlugin, conflict, overlaps, type Claim } from "@opencode/core/plugin/fork/write-scope"
import { testEffect } from "../../lib/effect"
import { host } from "../host"

const parent = SessionSchema.ID.make("ses_parent")
const otherParent = SessionSchema.ID.make("ses_other")
const first = SessionSchema.ID.make("ses_first")
const second = SessionSchema.ID.make("ses_second")

const claim = (sessionID: SessionSchema.ID, parentSessionID: SessionSchema.ID, roots: string[]): Claim => ({
  sessionID,
  parentSessionID,
  roots,
})

describe("overlaps", () => {
  test("treats a directory as covering its contents and nothing else", () => {
    expect(overlaps("/w/src", "/w/src/a.ts")).toBe(true)
    expect(overlaps("/w/src/a.ts", "/w/src")).toBe(true)
    expect(overlaps("/w/src", "/w/src")).toBe(true)
    // A shared string prefix is not an overlap: `/w/src-b` is a different tree.
    expect(overlaps("/w/src", "/w/src-b/a.ts")).toBe(false)
    expect(overlaps("/w/src/a", "/w/src/b")).toBe(false)
  })
})

describe("conflict", () => {
  test("finds a live sibling whose declared tree covers the new declaration", () => {
    const claims = [claim(first, parent, ["/w/src"])]
    expect(conflict(claims, { parentSessionID: parent, roots: ["/w/src/deep/file.ts"] })?.sessionID).toBe(first)
    expect(conflict(claims, { parentSessionID: parent, roots: ["/w/tests"] })).toBeUndefined()
  })

  test("ignores another parent's children: a different workstream is not a sibling", () => {
    const claims = [claim(first, otherParent, ["/w/src"])]
    expect(conflict(claims, { parentSessionID: parent, roots: ["/w/src"] })).toBeUndefined()
  })
})

const it = testEffect(Layer.empty)

type SpawnInput = { readonly prompt: string; readonly writeRoots?: readonly string[] }

/**
 * Runs the plugin against a subagent tool the test owns. The plugin extends the tool's input schema and
 * wraps its execute, so the assertions below read the same object the registry would.
 */
const setup = Effect.fnUntraced(function* (input: { children: SessionSchema.ID[]; running: SessionSchema.ID[] }) {
  const spawns: SpawnInput[] = []
  const tool: Tool.Info = {
    name: "subagent",
    description: "",
    input: Schema.Struct({ prompt: Schema.String }),
    execute: (value: SpawnInput, context: Tool.Context) =>
      Effect.gen(function* () {
        // The real tool reports the child it just created, after create and before the first prompt.
        const child = input.children[spawns.length] ?? first
        yield* context.progress({ sessionID: child, status: "running" })
        spawns.push(value)
        return { output: { sessionID: child, status: "running" as const, output: "ok" } }
      }),
  }
  const jobs = Layer.succeed(Job.Service, {
    get: (id: string) =>
      Effect.succeed({ id, status: input.running.includes(id as SessionSchema.ID) ? "running" : "completed" } as never),
    start: () => Effect.die("unused job.start"),
    wait: () => Effect.die("unused job.wait"),
    block: () => Effect.die("unused job.block"),
    background: () => Effect.die("unused job.background"),
    backgroundAll: () => Effect.die("unused job.backgroundAll"),
    cancel: () => Effect.die("unused job.cancel"),
    pendingBackground: Effect.die("unused job.pendingBackground"),
    completeBackground: () => Effect.die("unused job.completeBackground"),
  })
  yield* ForkWriteScopePlugin.Plugin.effect(
    host({
      location: {
        directory: "/w",
        project: { id: "prj_test", directory: "/w", canonical: "/w" },
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

  const spawn = (writeRoots?: readonly string[]) => {
    const context = {
      sessionID: parent,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      progress: () => Effect.void,
    } as unknown as Tool.Context
    const value = writeRoots === undefined ? { prompt: "work" } : { prompt: "work", writeRoots }
    return tool.execute(value, context).pipe(Effect.exit)
  }
  return { tool, spawn, spawns }
})

describe("fork write scope: the spawn wrapper", () => {
  it.effect("exposes writeRoots on the spawn schema without touching the original fields", () =>
    Effect.gen(function* () {
      const { tool } = yield* setup({ children: [first], running: [] })
      // Read the schema the model is handed, through the same helper the registry uses.
      const schema = definition(tool).inputSchema as {
        readonly properties?: Record<string, unknown>
        readonly required?: ReadonlyArray<string>
      }
      expect(Object.keys(schema.properties ?? {})).toContain("writeRoots")
      // The original field survives, so the extension did not replace the spawn schema.
      expect(Object.keys(schema.properties ?? {})).toContain("prompt")
      expect(schema.required ?? []).toContain("prompt")
      expect(schema.required ?? []).not.toContain("writeRoots")
    }),
  )

  it.effect("refuses a declared spawn that overlaps a live sibling and names the clash", () =>
    Effect.gen(function* () {
      const { spawn } = yield* setup({ children: [first, second], running: [first] })
      expect(Exit.isSuccess(yield* spawn(["src"]))).toBe(true)
      const refused = yield* spawn(["src/deep"])
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        const error = refused.cause.toString()
        expect(error).toContain(`overlaps subagent ${first}`)
        expect(error).toContain("/w/src")
      }
      // A sibling that stays out of the declared tree is unaffected.
      expect(Exit.isSuccess(yield* spawn(["tests"]))).toBe(true)
    }),
  )

  it.effect("leaves an undeclared spawn alone and records no claim for it", () =>
    Effect.gen(function* () {
      const { spawn, spawns } = yield* setup({ children: [first], running: [first] })
      expect(Exit.isSuccess(yield* spawn())).toBe(true)
      expect(spawns).toHaveLength(1)
      // No claim was registered, so a later declared spawn cannot clash with the undeclared one.
      expect(Exit.isSuccess(yield* spawn(["src"]))).toBe(true)
    }),
  )

  it.effect("forgets a claim once the child's job is no longer running", () =>
    Effect.gen(function* () {
      const running = [first]
      const { spawn } = yield* setup({ children: [first, second], running })
      expect(Exit.isSuccess(yield* spawn(["src"]))).toBe(true)
      expect(Exit.isFailure(yield* spawn(["src/deep"]))).toBe(true)
      running.length = 0
      expect(Exit.isSuccess(yield* spawn(["src/deep"]))).toBe(true)
    }),
  )
})
