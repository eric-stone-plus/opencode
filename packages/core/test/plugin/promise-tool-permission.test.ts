import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Effect, Exit, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

// A promise plugin cannot reach the permission service directly, so its tools
// assert through the host's blocking gate. These tests drive one registered
// tool across that boundary and pin the failure shapes the runner relies on:
// a deny and a corrected rejection arrive as message-carrying Tool.Error
// defeats, and a bare decline stays the very DeclinedError instance inside
// that wrapper (the runner's decline tunnel unwraps `Tool.Error.error` and
// matches it with `instanceof`).

const sessionID = Session.ID.make("ses_permission_tool")
const agent = Agent.ID.make("build")
const messageID = SessionMessage.ID.make("msg_permission_tool")

const recorded: Permission.AssertInput[] = []
const behavior: { current: Permission.Interface["assert"] } = { current: () => Effect.void }

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "allow" as const }),
    assert: (input) => behavior.current(input),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const it = testEffect(makePluginTestLayer(permissionLayer))

function runTool() {
  return Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* PluginPromise.fromPromise({
      id: "permission-tool",
      async setup(context) {
        await context.tool.transform((editor) =>
          editor.add({
            name: "request-edit",
            description: "Requests edit permission before continuing",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, tool) => {
              await context.permission.assert({
                sessionID: tool.sessionID,
                agent: tool.agent,
                action: "edit",
                resources: ["src/index.ts"],
                save: ["*"],
                metadata: { operation: "write" },
                source: { type: "tool", messageID: tool.messageID, id: tool.id },
              })
              return { content: "granted" }
            },
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))
    const tools = yield* Tool.Service
    const snapshot = yield* tools.snapshot()
    return yield* snapshot
      .execute({
        sessionID,
        agent,
        messageID,
        call: { type: "tool-call", id: "call_permission_tool", name: "request-edit", input: {} },
      })
      .pipe(Effect.exit)
  })
}

it.live("forwards the gate to the permission service and resumes on allow", () =>
  Effect.gen(function* () {
    recorded.length = 0
    behavior.current = (input) => {
      recorded.push(input)
      return Effect.void
    }
    const exit = yield* runTool()
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.content).toEqual([{ type: "text", text: "granted" }])
    expect(recorded).toEqual([
      {
        sessionID,
        agent,
        action: "edit",
        resources: ["src/index.ts"],
        save: ["*"],
        metadata: { operation: "write" },
        source: { type: "tool", messageID, id: "call_permission_tool" },
      },
    ])
  }),
)

it.live("a denied action surfaces the deny message", () =>
  Effect.gen(function* () {
    behavior.current = (input) =>
      Effect.fail(
        new Permission.BlockedError({
          rules: [],
          permission: input.action,
          resources: input.resources,
        }),
      )
    const exit = yield* runTool()
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const defect = Cause.squash(exit.cause)
    expect(defect).toBeInstanceOf(Tool.Error)
    expect((defect as Tool.Error).message).toBe("Permission denied: edit")
    expect((defect as Tool.Error).error).toBeInstanceOf(Permission.BlockedError)
  }),
)

it.live("a rejection with feedback arrives as the feedback error", () =>
  Effect.gen(function* () {
    behavior.current = () => Effect.fail(new Permission.CorrectedError({ feedback: "Use a narrower path" }))
    const exit = yield* runTool()
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const defect = Cause.squash(exit.cause)
    expect(defect).toBeInstanceOf(Tool.Error)
    expect((defect as Tool.Error).message).toBe("Use a narrower path")
    expect((defect as Tool.Error).error).toBeInstanceOf(Permission.CorrectedError)
  }),
)

it.live("a bare decline stays the exact DeclinedError instance inside the wrapper", () =>
  Effect.gen(function* () {
    const decline = new Permission.DeclinedError()
    behavior.current = () => Effect.die(decline)
    const exit = yield* runTool()
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const defect = Cause.squash(exit.cause)
    expect(defect).toBeInstanceOf(Tool.Error)
    expect((defect as Tool.Error).error).toBe(decline)
  }),
)
