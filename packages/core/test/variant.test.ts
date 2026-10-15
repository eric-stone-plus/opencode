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

test("effective defaults to the ladder top and honors explicit picks", () => {
  const ladder = (ids: string[]) =>
    ids.map((id) => ({ id: Model.VariantID.make(id), settings: {}, headers: {}, body: {} }))
  const model = (ids: string[]) => {
    const result = Model.Info.default(Provider.ID.make("test"), Model.ID.make("variant-model")) as Model.MutableInfo
    result.variants = ladder(ids) as Model.MutableInfo["variants"]
    return Model.Info.make(result)
  }

  // Unset and the `default` sentinel both resolve to the top rung.
  expect(String(Variant.effective(model(["low", "high", "max"]), undefined))).toBe("max")
  expect(String(Variant.effective(model(["low", "high", "max"]), Model.VariantID.make("default")))).toBe("max")
  // A ladder that lists a real `default` tier honors the sentinel as an
  // explicit pick of that tier (groq qwen3-32b's "none"|"default" axis).
  expect(String(Variant.effective(model(["none", "default"]), Model.VariantID.make("default")))).toBe("default")
  // An explicit pick is honored.
  expect(String(Variant.effective(model(["low", "high", "max"]), Model.VariantID.make("low")))).toBe("low")
  // A model without variants resolves to nothing.
  expect(Variant.effective(model([]), undefined)).toBeUndefined()
  expect(Variant.effective(model([]), Model.VariantID.make("default"))).toBeUndefined()
})
