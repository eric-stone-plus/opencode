import { expect } from "bun:test"
import { Tool } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const current = Session.ID.make("ses_current")
const other = Session.ID.make("ses_other")

const denial = (target: Session.ID) =>
  `Cannot target session ${target}: this tool only acts on the current session ${current}. ` +
  "Omit sessionID to target the current session."

it.effect("session tools act only on the calling session", () =>
  Effect.gen(function* () {
    const updates: Session.ID[] = []
    const moves: Session.ID[] = []
    yield* registerToolPlugin(OpenCodeTools.Plugin, {
      session: {
        update: (input) =>
          Effect.sync(() => {
            updates.push(input.sessionID)
          }),
        move: (input) =>
          Effect.sync(() => {
            moves.push(input.sessionID)
          }),
      },
    })
    const registry = yield* Tool.Service
    const call = (name: string, input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: current,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-${name}-${JSON.stringify(input)}`,
          name: "execute",
          input: { code: `return await tools.opencode.${name}(${JSON.stringify(input)})` },
        },
      })
    const run = (name: string, input: Record<string, unknown>) =>
      call(name, input).pipe(
        Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "")),
      )

    // Omitting sessionID and naming the current session both work.
    expect(yield* run("session_rename", { title: " Current title " })).toEqual({
      sessionID: current,
      title: "Current title",
    })
    expect(yield* run("session_rename", { sessionID: current, title: "Explicit title" })).toEqual({
      sessionID: current,
      title: "Explicit title",
    })
    expect(yield* run("session_move", { directory: "/tmp/opencode-current" })).toEqual({
      sessionID: current,
      directory: "/tmp/opencode-current",
    })
    expect(yield* run("session_move", { sessionID: current, directory: "/tmp/opencode-explicit" })).toEqual({
      sessionID: current,
      directory: "/tmp/opencode-explicit",
    })
    expect(updates).toEqual([current, current])
    expect(moves).toEqual([current, current])

    // A plugin cannot rename or move a different session by passing its ID.
    expect(yield* call("session_rename", { sessionID: other, title: "Hijacked" })).toMatchObject({
      content: [{ type: "text", text: denial(other) }],
      metadata: { error: true },
    })
    expect(yield* call("session_move", { sessionID: other, directory: "/tmp/opencode-other" })).toMatchObject({
      content: [{ type: "text", text: denial(other) }],
      metadata: { error: true },
    })
    expect(updates).toEqual([current, current])
    expect(moves).toEqual([current, current])
  }),
)
