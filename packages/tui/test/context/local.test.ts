import { describe, expect, test } from "bun:test"
import { parseModel, recentModels, resolveVariant } from "../../src/context/local"

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
    expect(
      resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe("max")
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
    expect(
      resolveVariant({ selected: undefined, variants, model: flash, agentModel: glm, agentVariant: "max" }),
    ).toBe(undefined)
  })

  test("S3: switched back to the agent model -> agent variant again", () => {
    expect(
      resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe("max")
  })

  test("S4: explicit selection wins over agent default, and switching back to max shows max", () => {
    expect(
      resolveVariant({ selected: "high", variants, model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe("high")
    expect(
      resolveVariant({ selected: "max", variants, model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe("max")
  })

  test("S6: explicit selection synced from an old session message is shown (regression)", () => {
    expect(
      resolveVariant({ selected: "max", variants, model: glm, agentModel: glm, agentVariant: "max" }),
    ).toBe("max")
    expect(
      resolveVariant({ selected: "high", variants, model: glm, agentModel: undefined, agentVariant: undefined }),
    ).toBe("high")
  })

  test("S7: agent without variant config keeps store-only behavior", () => {
    expect(
      resolveVariant({ selected: undefined, variants, model: glm, agentModel: glm, agentVariant: undefined }),
    ).toBe(undefined)
    expect(
      resolveVariant({ selected: "high", variants, model: glm, agentModel: glm, agentVariant: undefined }),
    ).toBe("high")
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
      resolveVariant({ selected: undefined, variants: ["high", "low"], model: glm, agentModel: build, agentVariant: "low" }),
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
