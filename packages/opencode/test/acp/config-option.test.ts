import { describe, expect, test } from "bun:test"
import {
  buildConfigOptions,
  buildEffortSelectOption,
  buildModeSelectOption,
  buildModelSelectOption,
  formatCurrentModelId,
  formatVariantName,
  parseModelSelection,
  type ConfigOptionProvider,
} from "@/acp/config-option"

const providers: ConfigOptionProvider[] = [
  {
    id: "alibaba",
    name: "Alibaba",
    models: {
      "qwen/max": {
        id: "qwen/max",
        name: "Qwen Max",
        variants: {
          default: {},
          high: {},
          "very-high": {},
        },
      },
      "qwen-flash": {
        id: "qwen-flash",
        name: "Qwen Flash",
      },
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        variants: {
          minimal: {},
          low: {},
        },
      },
    },
  },
]

describe("acp config options", () => {
  test("builds the model select option with ACP verifier category", () => {
    expect(
      buildModelSelectOption({
        providers,
        currentModel: { providerID: "alibaba", modelID: "qwen/max" },
        currentVariant: "high",
      }),
    ).toEqual({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "alibaba/qwen/max",
      options: [
        { value: "alibaba/qwen-flash", name: "Alibaba/Qwen Flash" },
        { value: "alibaba/qwen/max", name: "Alibaba/Qwen Max" },
        { value: "deepseek/deepseek-v4-flash", name: "DeepSeek/DeepSeek V4 Flash" },
      ],
    })
  })

  test("includes variant ids in the model option only when requested", () => {
    const option = buildModelSelectOption({
      providers,
      currentModel: { providerID: "alibaba", modelID: "qwen/max" },
      currentVariant: "high",
      includeVariants: true,
    })

    expect(option.currentValue).toBe("alibaba/qwen/max/high")
    if (option.type !== "select") throw new Error("expected select option")
    expect(option.options).toContainEqual({
      value: "alibaba/qwen/max/high",
      name: "Alibaba/Qwen Max (High)",
    })
    expect(option.options).not.toContainEqual({
      value: "alibaba/qwen/max/default",
      name: "Alibaba/Qwen Max (Default)",
    })
  })

  test("builds effort option from variants and falls back to default when current variant is invalid", () => {
    expect(buildEffortSelectOption({ variants: ["low", "default", "high"], currentVariant: "missing" })).toEqual({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: "default",
      options: [
        { value: "low", name: "Low" },
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
    })
  })

  test("effort fallback uses the first variant when default is absent", () => {
    expect(buildEffortSelectOption({ variants: ["minimal", "low"], currentVariant: "missing" })?.currentValue).toBe(
      "minimal",
    )
  })

  test("omits effort option when there are no variants", () => {
    expect(buildEffortSelectOption({ variants: [] })).toBeUndefined()
  })

  test("exposes an explicit default even when the provider only lists named variants", () => {
    expect(buildEffortSelectOption({ variants: ["low", "medium"], currentVariant: "default" })).toMatchObject({
      currentValue: "default",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "default", name: "Default" },
      ],
    })
  })

  test("builds the mode select option with descriptions when present", () => {
    expect(
      buildModeSelectOption({
        currentModeId: "build",
        modes: [
          { id: "build", name: "Build", description: "Make code changes" },
          { id: "plan", name: "Plan" },
        ],
      }),
    ).toEqual({
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "Build", description: "Make code changes" },
        { value: "plan", name: "Plan" },
      ],
    })
  })

  test("builds full config options with model, effort, and mode in stable order", () => {
    const options = buildConfigOptions({
      providers,
      currentModel: { providerID: "alibaba", modelID: "qwen/max" },
      currentVariant: "very-high",
      modes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
      currentModeId: "plan",
    })

    expect(options.map((option) => option.id)).toEqual(["model", "effort", "mode"])
    expect(options.map((option) => option.category)).toEqual(["model", "thought_level", "mode"])
    expect(options[1]?.currentValue).toBe("very-high")
  })

  test("full config options omit effort for models without variants", () => {
    expect(
      buildConfigOptions({
        providers,
        currentModel: { providerID: "alibaba", modelID: "qwen-flash" },
      }).map((option) => option.id),
    ).toEqual(["model"])
  })

  test("parses provider/model selections", () => {
    expect(parseModelSelection("deepseek/deepseek-v4-flash", providers)).toEqual({
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    })
  })

  test("parses provider/model/variant selections when the base model exposes that variant", () => {
    expect(parseModelSelection("deepseek/deepseek-v4-flash/low", providers)).toEqual({
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      variant: "low",
    })
  })

  test("prefers exact slash-containing model ids before treating the tail as a variant", () => {
    expect(parseModelSelection("alibaba/qwen/max", providers)).toEqual({
      model: { providerID: "alibaba", modelID: "qwen/max" },
    })
  })

  test("parses trailing variants for slash-containing model ids", () => {
    expect(parseModelSelection("alibaba/qwen/max/high", providers)).toEqual({
      model: { providerID: "alibaba", modelID: "qwen/max" },
      variant: "high",
    })
  })

  test("keeps unknown trailing segments in the model id when they are not valid variants", () => {
    expect(parseModelSelection("alibaba/qwen/max/missing", providers)).toEqual({
      model: { providerID: "alibaba", modelID: "qwen/max/missing" },
    })
  })

  test("formats current model ids with and without selected variants", () => {
    expect(
      formatCurrentModelId({
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        variant: "low",
        variants: ["minimal", "low"],
      }),
    ).toBe("deepseek/deepseek-v4-flash")
    expect(
      formatCurrentModelId({
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        variant: "low",
        variants: ["minimal", "low"],
        includeVariant: true,
      }),
    ).toBe("deepseek/deepseek-v4-flash/low")
  })

  test("formats current model ids with variant fallback", () => {
    expect(
      formatCurrentModelId({
        model: { providerID: "alibaba", modelID: "qwen/max" },
        variant: "missing",
        variants: ["default", "high"],
        includeVariant: true,
      }),
    ).toBe("alibaba/qwen/max/default")
  })

  test("formats variant names for display", () => {
    expect(formatVariantName("very_high-effort")).toBe("Very High Effort")
  })
})
