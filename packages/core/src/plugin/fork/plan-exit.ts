export * as ForkPlanExitPlugin from "./plan-exit.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { Global } from "@opencode/util/global"
import { Agent } from "../../agent.js"
import { Form } from "../../form.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import { ForkFiles } from "./files.js"
import DESCRIPTION from "./plan-exit.txt"

export const name = "plan_exit"

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  agent: Agent.ID.annotate({ description: "The agent the session switched to" }),
})

const planAgent = Agent.ID.make("plan")

/**
 * Plan approval and the switch out of plan mode. The fork's plan card tells the model to finish its
 * turn with this tool, so it must exist for plan mode to have a landing. Fail closed: any answer
 * short of an exact "Yes" — an empty reply, a typed free-form answer, a dismissal — is not consent,
 * and nothing on the session moves.
 */
export const Plugin = define({
  id: "fork.plan-exit",
  effect: Effect.fn("ForkPlanExitPlugin")(function* (ctx) {
    const agents = yield* Agent.Service
    const forms = yield* Form.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service

    // Shown the way the model names files: relative inside the Location, absolute outside (the plan
    // file normally lives in the global data directory).
    const display = (file: string) => {
      const relative = path.relative(location.directory, file)
      return relative.startsWith("..") ? file : relative.replaceAll("\\", "/")
    }

    // The profile that switched into plan is the one the plan lands on; a session that started in
    // plan falls back to the default agent, never a hardcoded one.
    const landing = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const switched = yield* sessions.messages({ sessionID, type: "agent-switched", order: "desc", limit: 50 })
      const previous = switched
        .filter((message): message is SessionMessage.AgentSelected => message.type === "agent-switched")
        .find((message) => message.agent === planAgent)?.previous
      if (previous !== undefined) return previous
      const [preferred] = yield* agents.list()
      return preferred?.id ?? Agent.ID.make("build")
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (_input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: plan_exit", error })))
              const file = ForkFiles.plan(global, context.sessionID)
              const shown = display(file)
              const target = yield* landing(context.sessionID)
              const state = yield* forms
                .ask({
                  sessionID: context.sessionID,
                  title: "Leave Plan Mode",
                  metadata: { kind: "question" },
                  fields: [
                    {
                      key: "q0",
                      title: "Leave Plan Mode",
                      description: `Plan at ${shown} is complete. Would you like to switch to the ${target} agent and start implementing?`,
                      type: "string",
                      options: [
                        {
                          value: "Yes",
                          label: "Yes",
                          description: `Switch to the ${target} agent and start implementing the plan`,
                        },
                        {
                          value: "No",
                          label: "No",
                          description: "Stay with plan agent to continue refining the plan",
                        },
                      ],
                      custom: true,
                    },
                  ],
                })
                .pipe(Effect.orDie)
              // `Form.Answer` has no length guarantee, so an empty or free-form reply reaches here.
              // This question is exactly Yes/No, so anything short of an explicit "Yes" stays put.
              const answered = state.status === "answered" ? state.answer["q0"] : undefined
              if (answered !== "Yes")
                return yield* new ToolFailure({
                  message:
                    state.status === "cancelled"
                      ? "The plan exit question was dismissed; stay in plan mode and continue refining the plan."
                      : "The plan was not approved; stay in plan mode and continue refining the plan.",
                })
              yield* sessions.switchAgent({ sessionID: context.sessionID, agent: target })
              yield* sessions.synthetic({
                sessionID: context.sessionID,
                text: `The plan at ${shown} has been approved, you can now edit files. Execute the plan`,
                resume: true,
              })
              return {
                output: { agent: target },
                content: `User approved switching to the ${target} agent. Wait for further instructions.`,
                metadata: { agent: target },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to exit plan mode", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
