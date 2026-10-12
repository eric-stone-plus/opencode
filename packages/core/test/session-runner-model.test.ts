import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ID, Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { testEffect } from "./lib/effect"

const asked = new Array<string>()
const resolved = (label: string) => ({ label }) as unknown as SessionRunnerModel.Resolved
const resolver = Layer.mock(ModelResolver.Service, {
  resolve: () => Effect.sync(() => (asked.push("default"), resolved("default"))),
  resolveModel: (model, variant) => Effect.sync(() => (asked.push(`${model.id}#${variant ?? ""}`), resolved(model.id))),
})
const it = testEffect(AppNodeBuilder.build(SessionRunnerModel.node, [ModelResolver.node.replace(resolver)]))

const info = (id: string) => ({ providerID: Provider.ID.make("p"), id: ID.make(id) }) as Model.Info
const catalog = () => Effect.succeed([info("agent-model"), info("session-model")])
const session = (model?: SessionSchema.Info["model"]) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_runner_model"),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: "/project" as never },
    ...(model ? { model } : {}),
  })
const preferred = { providerID: Provider.ID.make("p"), id: ID.make("agent-model"), variant: Model.VariantID.make("max") }

describe("SessionRunnerModel agent model", () => {
  it.effect("applies the agent's model and variant while the session has none", () =>
    Effect.gen(function* () {
      asked.length = 0
      const runner = yield* SessionRunnerModel.Service
      yield* runner.resolve(session(), catalog, preferred)
      expect(asked).toEqual(["agent-model#max"])
    }),
  )

  it.effect("keeps a model the session already has", () =>
    Effect.gen(function* () {
      asked.length = 0
      const runner = yield* SessionRunnerModel.Service
      yield* runner.resolve(
        session({ providerID: Provider.ID.make("p"), id: ID.make("session-model"), variant: Model.VariantID.make("low") }),
        catalog,
        preferred,
      )
      expect(asked).toEqual(["session-model#low"])
    }),
  )

  it.effect("falls back to the default model when the agent's model is not in the catalog", () =>
    Effect.gen(function* () {
      asked.length = 0
      const runner = yield* SessionRunnerModel.Service
      yield* runner.resolve(session(), () => Effect.succeed([info("other")]), preferred)
      expect(asked).toEqual(["default"])
    }),
  )

  it.effect("uses the default model when the agent sets none", () =>
    Effect.gen(function* () {
      asked.length = 0
      const runner = yield* SessionRunnerModel.Service
      yield* runner.resolve(session(), catalog)
      expect(asked).toEqual(["default"])
    }),
  )
})
