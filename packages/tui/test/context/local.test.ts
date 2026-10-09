import { describe, expect, test } from "bun:test"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  adoptVariant,
  configuredModel,
  DRAFT_MODEL_SCOPE,
  effectiveVariant,
  modelScope,
  normalizeVariantStore,
  parseModel,
  readVariant,
  recentModels,
  resolveModel,
  resolveVariant,
  variantAfterModelChange,
  type VariantStore,
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

describe("effectiveVariant (display-only model pin fallback)", () => {
  test("no explicit/agent variant, model pins reasoningEffort -> pinned value is shown", () => {
    expect(
      effectiveVariant({
        selected: undefined,
        variants,
        model: glm,
        agentModel: undefined,
        agentVariant: undefined,
        pinned: "max",
      }),
    ).toBe("max")
  })

  test("explicit selection wins over the pin", () => {
    expect(
      effectiveVariant({
        selected: "high",
        variants,
        model: glm,
        agentModel: glm,
        agentVariant: "max",
        pinned: "max",
      }),
    ).toBe("high")
  })

  test("agent variant wins over the pin when the same-model gate holds", () => {
    expect(
      effectiveVariant({
        selected: undefined,
        variants,
        model: glm,
        agentModel: glm,
        agentVariant: "high",
        pinned: "max",
      }),
    ).toBe("high")
  })

  test("agent variant gated off by a different model -> the pin still describes the request", () => {
    expect(
      effectiveVariant({
        selected: undefined,
        variants,
        model: flash,
        agentModel: glm,
        agentVariant: "high",
        pinned: "max",
      }),
    ).toBe("max")
  })

  test("a pin outside the model's variant list is not shown", () => {
    expect(
      effectiveVariant({
        selected: undefined,
        variants: ["high"],
        model: glm,
        agentModel: undefined,
        agentVariant: undefined,
        pinned: "max",
      }),
    ).toBe(undefined)
  })

  test("no pin and no resolution -> nothing shown", () => {
    expect(
      effectiveVariant({
        selected: undefined,
        variants,
        model: glm,
        agentModel: undefined,
        agentVariant: undefined,
        pinned: undefined,
      }),
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

  test("an invalid configured fallback is kept so the server reports ModelNotFound", () => {
    const none = () => false
    expect(
      resolveModel({ choice: undefined, agentModel: undefined, fallback: mimo, configured: true, valid: none }),
    ).toEqual(mimo)
    expect(resolveModel({ choice: undefined, agentModel: undefined, fallback: mimo, valid: none })).toBeUndefined()
    const onlyOpus = (model: { modelID: string }) => model.modelID === opus.modelID
    expect(
      resolveModel({ choice: undefined, agentModel: opus, fallback: mimo, configured: true, valid: onlyOpus }),
    ).toEqual(opus)
  })

  test("--model takes precedence over the config model", () => {
    expect(configuredModel({ arg: "a/x", config: "b/y" })).toEqual({ providerID: "a", modelID: "x", source: "--model" })
    expect(configuredModel({ config: "b/y/z" })).toEqual({ providerID: "b", modelID: "y/z", source: "config" })
    expect(configuredModel({})).toBeUndefined()
  })

  test("a stored variant the new model does not offer is dropped", () => {
    expect(variantAfterModelChange("max", ["high", "low"])).toBeUndefined()
    expect(variantAfterModelChange("high", ["high", "low"])).toBe("high")
    expect(variantAfterModelChange("default", ["high"])).toBe("default")
    expect(variantAfterModelChange(undefined, [])).toBeUndefined()
  })
})

describe("session-scoped variant store", () => {
  const glm = { providerID: "zai", modelID: "glm-5.3" }

  test("variants do not leak across scopes", () => {
    const store = { ses_a: { "zai/glm-5.3": "max" } }
    expect(readVariant(store, "ses_a", glm)).toBe("max")
    expect(readVariant(store, "ses_b", glm)).toBeUndefined()
    expect(readVariant(store, DRAFT_MODEL_SCOPE, glm)).toBeUndefined()
  })

  test("legacy flat variant maps migrate into the draft scope", () => {
    expect(normalizeVariantStore({ "zai/glm-5.3": "max", "zai/glm-5.3-flash": "high" })).toEqual({
      [DRAFT_MODEL_SCOPE]: { "zai/glm-5.3": "max", "zai/glm-5.3-flash": "high" },
    })
  })

  test("nested maps are preserved and junk is dropped", () => {
    expect(
      normalizeVariantStore({
        ses_a: { "zai/glm-5.3": "high", bad: 7 },
        broken: 3,
        nil: null,
        empty: {},
      }),
    ).toEqual({ ses_a: { "zai/glm-5.3": "high" } })
  })

  test("a mixed map keeps both the legacy entries and the scoped buckets", () => {
    expect(
      normalizeVariantStore({
        "zai/glm-5.3": "max",
        ses_a: { "zai/glm-5.3": "high" },
      }),
    ).toEqual({
      [DRAFT_MODEL_SCOPE]: { "zai/glm-5.3": "max" },
      ses_a: { "zai/glm-5.3": "high" },
    })
  })

  test("migration merges a legacy flat entry into an existing draft bucket", () => {
    expect(
      normalizeVariantStore({
        "zai/glm-5.3": "max",
        [DRAFT_MODEL_SCOPE]: { "zai/glm-5.3-flash": "low" },
      }),
    ).toEqual({
      [DRAFT_MODEL_SCOPE]: { "zai/glm-5.3": "max", "zai/glm-5.3-flash": "low" },
    })
  })

  test("array buckets and unsafe keys are dropped", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": "yes"}, "ses_b": {"zai/glm-5.3": "high"}}')
    const normalized = normalizeVariantStore(parsed)
    expect(normalized).toEqual({ ses_b: { "zai/glm-5.3": "high" } })
    expect((normalized as Record<string, unknown>)["polluted"]).toBeUndefined()
    expect(normalizeVariantStore({ ses_a: ["not", "a", "bucket"] })).toEqual({})
  })

  test("adopt copies the draft bucket and clears it without aliasing", () => {
    const store = {
      ses_a: { "zai/glm-5.3": "max" },
      [DRAFT_MODEL_SCOPE]: { "zai/glm-5.3": "low" },
    }
    const next = adoptVariant(store, "ses_b")
    expect(next).toEqual({
      ses_a: { "zai/glm-5.3": "max" },
      ses_b: { "zai/glm-5.3": "low" },
      [DRAFT_MODEL_SCOPE]: {},
    })
    expect(next[DRAFT_MODEL_SCOPE]).not.toBe(store[DRAFT_MODEL_SCOPE])
    expect(next.ses_b).not.toBe(store[DRAFT_MODEL_SCOPE])
    next.ses_b["zai/glm-5.3"] = "high"
    expect(next[DRAFT_MODEL_SCOPE]).toEqual({})
  })

  test("a reconciled adopt keeps the session and draft buckets independent", () => {
    const [store, setStore] = createStore<{ variant: VariantStore }>({ variant: {} })
    setStore("variant", DRAFT_MODEL_SCOPE, { "zai/glm-5.3": "low" })
    setStore("variant", "ses_a", { "zai/glm-5.3": "max" })
    setStore("variant", reconcile(adoptVariant(store.variant, "ses_b")))
    expect(store.variant[DRAFT_MODEL_SCOPE]).toEqual({})
    expect(store.variant["ses_b"]).toEqual({ "zai/glm-5.3": "low" })

    // A later pick inside the session must not surface in the draft bucket.
    setStore(
      produce((draft) => {
        draft.variant["ses_b"]!["zai/glm-5.3"] = "high"
      }),
    )
    expect(store.variant[DRAFT_MODEL_SCOPE]).toEqual({})
    expect(store.variant["ses_a"]).toEqual({ "zai/glm-5.3": "max" })
    expect(store.variant["ses_b"]).toEqual({ "zai/glm-5.3": "high" })
  })
})
