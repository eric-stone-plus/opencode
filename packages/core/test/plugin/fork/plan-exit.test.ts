import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Form } from "@opencode/core/form"
import { ForkPlanExitPlugin } from "@opencode/core/plugin/fork/plan-exit"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { tempGlobalLayer } from "../../fixture/global"
import { location } from "../../fixture/location"
import { testEffect } from "../../lib/effect"
import { permissionLayer } from "../../lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "../../lib/tool"

const sessionID = SessionSchema.ID.make("ses_plan_exit_test")
const workspace = AbsolutePath.make("/workspace")

let history: SessionMessage.Info[] = []
let state: Form.TerminalState = { status: "answered", answer: { q0: "Yes" } }
let captured: Form.CreateInput | undefined
const switched: Array<{ sessionID: string; agent: string }> = []
const synthetic: Array<{ sessionID: string; text: string; resume: boolean | undefined }> = []

const switchedToPlan = SessionMessage.AgentSelected.make({
  id: SessionMessage.ID.make("msg_agent_switched_test"),
  type: "agent-switched",
  agent: Agent.ID.make("plan"),
  previous: Agent.ID.make("auto"),
  time: { created: DateTime.makeUnsafe(0) },
})

const form = Layer.mock(Form.Service, {
  ask: (input: Form.CreateInput) =>
    Effect.sync(() => {
      captured = input
    }).pipe(Effect.as(state)),
})

const unusedRevert = {
  stage: () => Effect.die("unused session.revert.stage"),
  clear: () => Effect.die("unused session.revert.clear"),
  commit: () => Effect.die("unused session.revert.commit"),
}

const session = Layer.mock(Session.Service, {
  revert: unusedRevert,
  messages: () => Effect.succeed(history),
  switchAgent: (input) =>
    Effect.sync(() => {
      switched.push({ sessionID: String(input.sessionID), agent: String(input.agent) })
    }),
  synthetic: (input) =>
    Effect.sync(() => {
      synthetic.push({ sessionID: String(input.sessionID), text: input.text, resume: input.resume })
    }).pipe(
      Effect.as(
        SessionInbox.Synthetic.make({
          id: SessionMessage.ID.make("msg_plan_exit_synthetic"),
          sessionID,
          time: { created: DateTime.makeUnsafe(0) },
          type: "synthetic",
          payload: { text: input.text },
          delivery: "steer",
        }),
      ),
    ),
})

const node = makeLocationNode({
  name: "test/plan-exit-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ForkPlanExitPlugin.Plugin)),
  deps: [Tool.node, Agent.node, Form.node, Global.node, Location.node, Permission.node, Session.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, Agent.node, node]), [
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Form.node.replace(form),
    Session.node.replace(session),
    Global.node.replace(tempGlobalLayer),
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory: workspace })))),
  ]),
)

const run = () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-plan-exit", name: "plan_exit", input: {} },
    })
  })

const reset = () => {
  history = []
  state = { status: "answered", answer: { q0: "Yes" } }
  captured = undefined
  switched.length = 0
  synthetic.length = 0
}

/** The text of a normalized tool result. */
const text = (content: unknown) =>
  Array.isArray(content)
    ? content.map((part: { text?: string }) => part.text ?? "").join("")
    : typeof content === "string"
      ? content
      : ""

describe("ForkPlanExit", () => {
  it.effect("is hidden from agents whose rules deny plan_exit", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const names = (rules: Parameters<typeof toolDefinitions>[1]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((tools) => tools.map((tool) => tool.name)))
      expect(yield* names([{ action: "plan_exit", resource: "*", effect: "deny" }])).not.toContain("plan_exit")
      expect(yield* names([{ action: "plan_exit", resource: "*", effect: "allow" }])).toContain("plan_exit")
    }),
  )

  it.effect("asks with the plan path and switches to the profile that entered plan on Yes", () =>
    Effect.gen(function* () {
      reset()
      history = [switchedToPlan]
      const result = yield* run()
      expect(result.status).toBe("completed")
      expect(result.output).toEqual({ agent: "auto" })
      expect(text(result.content)).toContain("User approved switching to the auto agent")
      expect(captured?.fields).toHaveLength(1)
      const field = captured?.fields[0]
      expect(field?.title).toBe("Leave Plan Mode")
      expect(String(field?.description)).toContain("is complete")
      expect(String(field?.description)).toContain("switch to the auto agent")
      const options = field?.type === "string" ? field.options : undefined
      expect(options?.map((option) => option.label)).toEqual(["Yes", "No"])
      expect(switched).toEqual([{ sessionID: "ses_plan_exit_test", agent: "auto" }])
      expect(synthetic).toHaveLength(1)
      expect(synthetic[0]?.text).toContain("has been approved, you can now edit files. Execute the plan")
      expect(synthetic[0]?.resume).toBe(true)
    }),
  )

  it.effect("stays in plan mode on No and changes nothing", () =>
    Effect.gen(function* () {
      reset()
      history = [switchedToPlan]
      state = { status: "answered", answer: { q0: "No" } }
      const result = yield* run()
      expect(result.status).toBe("error")
      expect(result.error?.message).toContain("was not approved")
      expect(switched).toHaveLength(0)
      expect(synthetic).toHaveLength(0)
    }),
  )

  it.effect("stays in plan mode when the question is dismissed", () =>
    Effect.gen(function* () {
      reset()
      history = [switchedToPlan]
      state = { status: "cancelled" }
      const result = yield* run()
      expect(result.status).toBe("error")
      expect(result.error?.message).toContain("dismissed")
      expect(switched).toHaveLength(0)
      expect(synthetic).toHaveLength(0)
    }),
  )

  it.effect("fails closed on a free-form answer that is not Yes", () =>
    Effect.gen(function* () {
      reset()
      history = [switchedToPlan]
      state = { status: "answered", answer: { q0: "yes please" } }
      const result = yield* run()
      expect(result.status).toBe("error")
      expect(switched).toHaveLength(0)
    }),
  )

  it.effect("lands on the default agent when no earlier switch into plan is recorded", () =>
    Effect.gen(function* () {
      reset()
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("goal"), (agent) => {
          agent.mode = "primary"
        })
        editor.default(Agent.ID.make("goal"))
      })
      const result = yield* run()
      expect(result.status).toBe("completed")
      expect(switched).toEqual([{ sessionID: "ses_plan_exit_test", agent: "goal" }])
      expect(result.output).toEqual({ agent: "goal" })
    }),
  )
})
