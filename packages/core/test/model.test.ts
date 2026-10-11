import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const decode = Schema.decodeUnknownSync(ModelV2.Ref)

describe("ModelV2.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "deepseek-flash", providerID: "deepseek" })).toEqual({
      id: ModelV2.ID.make("deepseek-flash"),
      providerID: ProviderV2.ID.make("deepseek"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "deepseek-flash", providerID: "deepseek", variant: "high" })).toEqual({
      id: ModelV2.ID.make("deepseek-flash"),
      providerID: ProviderV2.ID.make("deepseek"),
      variant: ModelV2.VariantID.make("high"),
    })
  })
})
