import { expect, test } from "bun:test"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Variant } from "@opencode/core/variant"

const model = (packageName: string, modelID: string, output?: number, providerID = "test") => {
  const result = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID)) as Model.MutableInfo
  result.package = packageName
  result.modelID = Model.ID.make(modelID)
  if (output !== undefined) result.limit = { ...result.limit, output }
  return Model.Info.make(result)
}

const resolve = (input: Model.Info, supports: readonly Variant.Support[]) =>
  Variant.resolve(input, supports).map((item) => ({ ...item, id: String(item.id) }))

test("recognizes Claude version spellings and future models", () => {
  for (const id of ["claude-sonnet-3.7", "claude-sonnet-3-7", "claude-3.7-sonnet", "claude-3-7-sonnet"])
    expect(resolve(model("@opencode/ai/providers/anthropic", id), [{ type: "effort" }])).toEqual([
      { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16000 } } },
      { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 31999 } } },
    ])

  expect(resolve(model("@opencode/ai/providers/anthropic", "claude-opus-6"), [{ type: "effort" }])).toEqual(
    ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
      id: effort,
      settings: { effort, thinking: { type: "adaptive", display: "summarized" } },
    })),
  )

  expect(
    resolve(model("@opencode/ai/providers/anthropic", "claude-haiku-4-5", 64_000), [
      { type: "budget_tokens", min: 1_024, max: 64_000 },
    ]),
  ).toEqual([
    { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
    { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 31_999 } } },
  ])
})

test("caps Alibaba thinking budget variants at 64k", () => {
  const supports: Variant.Support[] = [{ type: "toggle" }, { type: "budget_tokens" }]
  expect(resolve(model("@opencode/ai/providers/alibaba/chat", "kimi-k2.6", 262_144), supports)).toEqual([
    { id: "none", settings: { enableThinking: false } },
    { id: "high", settings: { enableThinking: true, thinkingBudget: 32_000 } },
    { id: "max", settings: { enableThinking: true, thinkingBudget: 63_999 } },
  ])
  expect(resolve(model("@opencode/ai/providers/alibaba/messages", "kimi-k2.6", 262_144), supports)).toEqual([
    { id: "none", settings: { thinking: { type: "disabled" } } },
    { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 32_000 } } },
    { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 63_999 } } },
  ])
  expect(resolve(model("@opencode/ai/providers/alibaba/chat", "kimi-k2.5", 32_768), supports)).toEqual([
    { id: "none", settings: { enableThinking: false } },
    { id: "high", settings: { enableThinking: true, thinkingBudget: 16_384 } },
    { id: "max", settings: { enableThinking: true, thinkingBudget: 32_767 } },
  ])
})
