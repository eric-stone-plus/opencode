import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          // Landing profile: the agent of the last user turn that was not
          // plan (plan is the mode being left), falling back to the default
          // agent (Auto) — not hardcoded "build".
          const history = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const landingAgent =
            history.findLast((item) => item.info.role === "user" && item.info.agent !== "plan")?.info.agent ??
            (yield* agents.defaultAgent())
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the ${landingAgent} agent and start implementing?`,
                header: "Leave Plan Mode",
                custom: false,
                options: [
                  { label: "Yes", description: `Switch to the ${landingAgent} agent and start implementing the plan` },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          // Fail closed. `Reply.answers` has no minLength, so an empty reply
          // reaches here; matching only "No" treated that as approval and
          // synthesized a user message unlocking edits. This question is
          // custom: false with exactly Yes/No, so anything short of an
          // explicit "Yes" is not consent to leave plan mode.
          if (answers[0]?.[0] !== "Yes") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: landingAgent,
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies SessionV1.TextPart)
          // Keep the session row in sync so the TUI shows the landing profile
          // instead of the stale plan agent. Only the agent changes: the
          // session row's model ({id, providerID, variant}) is preserved.
          yield* session.setAgentModel({
            sessionID: ctx.sessionID,
            agent: landingAgent,
            model: info.model ?? { id: model.modelID, providerID: model.providerID, variant: "default" },
            time: Date.now(),
          })

          return {
            title: `Switching to ${landingAgent} agent`,
            output: `User approved switching to the ${landingAgent} agent. Wait for further instructions.`,
            // ToolStateCompleted.metadata is Record<string, Schema.Any>
            // (packages/schema/src/v1/session.ts); the TUI reads `agent` from
            // here to derive the post-plan profile.
            metadata: { agent: landingAgent },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
