import { describe, expect, test } from "bun:test"
import {
  DRAFT_MODEL_SCOPE,
  modelScope,
  parseModel,
  recentModels,
  resolveModel,
  resolveVariant,
  variantAfterModelChange,
} from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

// Mirrors server truth in packages/opencode/src/session/prompt.ts createUserMessage:
//   model   = input.model ?? ag.model ?? currentModel(session)
//   same    = ag.model && model == ag.model
//   variant = input.variant ?? (ag.variant && same && variants[ag.variant] ? ag.variant : undefined)
const glm = { providerID: "zai", modelID: "glm-5.3" }
const flash = { providerID: "zai", modelID: "glm-5.3-flash" }
const variants = ["max", "high"]

describe("resolveVariant", () => {
  test("S1: no explicit selection, model == agent model, agent variant in list -> agent variant", () => {
    expect(resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: "max" })).toBe(
      "max",
    )
  })

  test("S5: stored 'default' sentinel (even as a literal variant name) is treated as unselected -> agent fallback", () => {
    expect(
      resolveVariant({
        selected: "default",
        variants: ["default", "max", "high"],
        model: glm,
        agentModel: glm,
        agentVariant: "max",
      }),
    ).toBe("max")
  })

  test("S2: user switched model away from agent model -> no variant", () => {
    expect(resolveVariant({ selected: undefined, variants, model: flash, agentModel: glm, agentVariant: "max" })).toBe(
      undefined,
    )
  })

  test("S3: switched back to the agent model -> agent variant again", () => {
    expect(resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: "max" })).toBe(
      "max",
    )
  })

  test("S4: explicit selection wins over agent default, and switching back to max shows max", () => {
    expect(resolveVariant({ selected: "high", variants, model: glm, agentModel: glm, agentVariant: "max" })).toBe(
      "high",
    )
    expect(resolveVariant({ selected: "max", variants, model: glm, agentModel: glm, agentVariant: "max" })).toBe("max")
  })

  test("S6: explicit selection synced from an old session message is shown (regression)", () => {
    expect(resolveVariant({ selected: "max", variants, model: glm, agentModel: glm, agentVariant: "max" })).toBe("max")
    expect(
      resolveVariant({ selected: "high", variants, model: glm, agentModel: undefined, agentVariant: undefined }),
    ).toBe("high")
  })

  test("S7: agent without variant config keeps store-only behavior", () => {
    expect(
      resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: undefined }),
    ).toBe(undefined)
    expect(resolveVariant({ selected: "high", variants, model: glm, agentModel: glm, agentVariant: undefined })).toBe(
      "high",
    )
  })

  test("S8: switching agents resolves against that agent's model/variant", () => {
    const build = { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
    expect(
      resolveVariant({
        selected: undefined,
        variants: ["high", "low"],
        model: build,
        agentModel: build,
        agentVariant: "low",
      }),
    ).toBe("low")
    expect(
      resolveVariant({
        selected: undefined,
        variants: ["high", "low"],
        model: glm,
        agentModel: build,
        agentVariant: "low",
      }),
    ).toBe(undefined)
  })

  test("agent variant missing from the model's variant list is not shown (server checks variants[ag.variant])", () => {
    expect(
      resolveVariant({ selected: undefined, variants: ["high"], model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe(undefined)
  })

  test("agent without a model never triggers the fallback (server: same requires ag.model)", () => {
    expect(
      resolveVariant({ selected: undefined, variants, model: glm, agentModel: undefined, agentVariant: "max" }),
    ).toBe(undefined)
  })
})

describe("session-scoped model", () => {
  const mimo = { providerID: "xiaomi", modelID: "mimo" }
  const qwen = { providerID: "alibaba", modelID: "qwen" }
  const opus = { providerID: "anthropic", modelID: "opus" }
  const valid = () => true

  test("modelScope keys sessions by ID and everything else as the draft", () => {
    expect(modelScope({ type: "session", sessionID: "ses_a" })).toBe("ses_a")
    expect(modelScope({ type: "home" })).toBe(DRAFT_MODEL_SCOPE)
    expect(modelScope({ type: "plugin", id: "x" })).toBe(DRAFT_MODEL_SCOPE)
  })

  test("an explicit session choice wins over the agent pin and the fallback", () => {
    expect(resolveModel({ choice: qwen, agentModel: opus, fallback: mimo, valid })).toEqual(qwen)
    expect(resolveModel({ choice: qwen, agentModel: undefined, fallback: mimo, valid })).toEqual(qwen)
  })

  test("without a choice the agent pin applies, then the fallback", () => {
    for (const choice of [undefined, null]) {
      expect(resolveModel({ choice, agentModel: opus, fallback: mimo, valid })).toEqual(opus)
      expect(resolveModel({ choice, agentModel: undefined, fallback: mimo, valid })).toEqual(mimo)
    }
  })

  test("invalid candidates are skipped", () => {
    const only = (model: { modelID: string }) => model.modelID === "mimo"
    expect(resolveModel({ choice: qwen, agentModel: opus, fallback: mimo, valid: only })).toEqual(mimo)
    expect(resolveModel({ choice: qwen, agentModel: opus, fallback: undefined, valid: only })).toBeUndefined()
  })

  test("a stored variant the new model does not offer is dropped", () => {
    expect(variantAfterModelChange("max", ["high", "low"])).toBeUndefined()
    expect(variantAfterModelChange("high", ["high", "low"])).toBe("high")
    expect(variantAfterModelChange("default", ["high"])).toBe("default")
    expect(variantAfterModelChange(undefined, [])).toBeUndefined()
  })
})
