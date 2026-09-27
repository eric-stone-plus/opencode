import { describe, expect, test } from "bun:test"
import { glmFaceOf, glmNative } from "@/provider/glm"

describe("glmFaceOf", () => {
  test("maps SDK package names to transport faces", () => {
    expect(glmFaceOf("@ai-sdk/openai-compatible")).toBe("zhipuai")
    expect(glmFaceOf("@ai-sdk/anthropic")).toBe("anthropic")
    expect(glmFaceOf("@openrouter/ai-sdk-provider")).toBe("other")
    expect(glmFaceOf(undefined)).toBe("other")
  })
})

describe("glmNative", () => {
  test("glm-5.3 on the zhipuai face accepts the full native effort ladder", () => {
    expect(glmNative({ modelID: "glm-5.3", reasoning: true }, "zhipuai")).toEqual({
      generation: "5.x",
      efforts: ["low", "high", "max"],
      thinkingDefault: "on",
      suppressGenericEfforts: false,
      unknown: false,
    })
  })

  test("glm-5.3 on the anthropic face only accepts high and max", () => {
    expect(glmNative({ modelID: "glm-5.3", reasoning: true }, "anthropic")).toEqual({
      generation: "5.x",
      efforts: ["high", "max"],
      thinkingDefault: null,
      suppressGenericEfforts: false,
      unknown: false,
    })
  })

  test("glm-4.6 on the zhipuai face keeps native efforts but suppresses the generic ladder", () => {
    expect(glmNative({ modelID: "glm-4.6", reasoning: true }, "zhipuai")).toEqual({
      generation: "4.x",
      efforts: ["low", "high", "max"],
      thinkingDefault: "on",
      suppressGenericEfforts: true,
      unknown: false,
    })
  })

  test("glm-4.6 on the anthropic face has no effort ladder at all", () => {
    expect(glmNative({ modelID: "glm-4.6", reasoning: true }, "anthropic")).toEqual({
      generation: "4.x",
      efforts: [],
      thinkingDefault: null,
      suppressGenericEfforts: true,
      unknown: false,
    })
  })

  test("unknown glm-5.4 is treated as the latest known 5.x generation and flagged", () => {
    const spec = glmNative({ modelID: "glm-5.4", reasoning: true }, "zhipuai")
    expect(spec).toMatchObject({ generation: "5.x", unknown: true, efforts: ["low", "high", "max"] })
  })

  test("unseen major versions clamp to the latest known generation and are flagged", () => {
    const spec = glmNative({ modelID: "glm-6.1", reasoning: true }, "anthropic")
    expect(spec).toMatchObject({ generation: "5.x", unknown: true, efforts: ["high", "max"] })
  })

  test("glm-5.3-air matches via the version-prefix anchor", () => {
    const spec = glmNative({ modelID: "glm-5.3-air", reasoning: true }, "anthropic")
    expect(spec).toMatchObject({ generation: "5.x", efforts: ["high", "max"], unknown: false })
  })

  test("my-glm-tuned-llama is excluded by the prefix anchor on every face", () => {
    expect(glmNative({ modelID: "my-glm-tuned-llama", reasoning: true }, "zhipuai")).toBe(false)
    expect(glmNative({ modelID: "my-glm-tuned-llama", reasoning: true }, "anthropic")).toBe(false)
  })

  test("non-GLM model families never match", () => {
    expect(glmNative({ modelID: "kimi-k2-thinking", reasoning: true }, "zhipuai")).toBe(false)
    expect(glmNative({ modelID: "gpt-5.2", reasoning: true }, "anthropic")).toBe(false)
  })

  test("glm ids without a parseable version are not guessed", () => {
    expect(glmNative({ modelID: "glm-5", reasoning: true }, "zhipuai")).toBe(false)
    expect(glmNative({ modelID: "glm-5p2", reasoning: true }, "anthropic")).toBe(false)
  })

  test("non-reasoning models get no capability spec", () => {
    expect(glmNative({ modelID: "glm-5.3", reasoning: false }, "zhipuai")).toBe(false)
  })
})
