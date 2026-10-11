import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"

  const mockModel = {
    id: "bailian-token-plan-personal/qwen3.8-max",
    providerID: "bailian-token-plan-personal",
    api: {
      id: "qwen3.8-max",
      url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1",
      npm: "@ai-sdk/anthropic",
    },
    name: "Qwen3.8 Max",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: true },
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: undefined,
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set prompt_cache_key for the deepseek provider on the OpenAI-compatible SDK", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "deepseek",
        api: { id: "deepseek-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
      },
      sessionID,
      providerOptions: {},
    })
    // DeepSeek's documented cache-affinity field, distinct from the
    // OpenAI SDK's promptCacheKey camelCase spelling.
    expect(result.prompt_cache_key).toBe(sessionID)
  })

  test("should not set prompt_cache_key for deepseek when explicitly disabled", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "deepseek",
        api: { id: "deepseek-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
      },
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.prompt_cache_key).toBeUndefined()
  })

  test("should not set prompt_cache_key for other OpenAI-compatible providers", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "xiaomi-token-plan-cn",
        api: { id: "mimo-v2.6-pro", url: "https://token-plan-cn.xiaomimimo.com/v1", npm: "@ai-sdk/openai-compatible" },
      },
      sessionID,
      providerOptions: {},
    })
    // MiMo/GLM cache-key semantics are unverified — stay conservative.
    expect(result.prompt_cache_key).toBeUndefined()
  })

  test("should never leak the harness-only workingContextCap into providerOptions", () => {
    const model = {
      ...mockModel,
      providerID: "deepseek",
      api: { id: "deepseek-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
    }
    const result = ProviderTransform.providerOptions(model, {
      workingContextCap: 606_784,
      maxOutputTokens: 393_216,
    })
    // openai-compatible spreads unknown keys into the request body, so the
    // compaction knob must be stripped while real wire options survive.
    // (sdkKey has no openai-compatible case — options ride the providerID key.)
    const wire = result.openaiCompatible ?? result.deepseek ?? result
    expect(wire.workingContextCap).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("workingContextCap")
    expect(wire.maxOutputTokens).toBe(393_216)
  })
})

describe("ProviderTransform.options - alibaba-cn enable_thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "alibaba-cn/qwen-plus",
      providerID: "alibaba-cn",
      api: {
        id: "qwen-plus",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Qwen Plus",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("enables thinking for reasoning models on the DashScope compatible API", () => {
    expect(ProviderTransform.options({ model: createModel(), sessionID }).enable_thinking).toBe(true)
  })

  test("leaves non-reasoning models alone", () => {
    const model = createModel({ capabilities: { ...createModel().capabilities, reasoning: false } })
    expect(ProviderTransform.options({ model, sessionID }).enable_thinking).toBeUndefined()
  })

  test("leaves other providers alone", () => {
    expect(
      ProviderTransform.options({ model: createModel({ providerID: "deepseek" }), sessionID }).enable_thinking,
    ).toBeUndefined()
  })

  test("does not force thinking on models that already return reasoning_content", () => {
    const model = createModel({ api: { ...createModel().api, id: "kimi-k2-thinking" } })
    expect(ProviderTransform.options({ model, sessionID }).enable_thinking).toBeUndefined()
  })
})

describe("ProviderTransform.options - anthropic tool streaming", () => {
  const sessionID = "test-session-123"

  const createModel = (npm: string) =>
    ({
      id: "test/test-model",
      providerID: "test",
      api: { id: "test-model", url: "https://api.test.com", npm },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("disables tool streaming for anthropic-package models", () => {
    expect(ProviderTransform.options({ model: createModel("@ai-sdk/anthropic"), sessionID }).toolStreaming).toBe(false)
  })

  test("leaves tool streaming alone for openai-compatible models", () => {
    expect(
      ProviderTransform.options({ model: createModel("@ai-sdk/openai-compatible"), sessionID }).toolStreaming,
    ).toBeUndefined()
  })
})

describe("ProviderTransform.options - zai/zhipuai thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (providerID: string) =>
    ({
      id: `${providerID}/glm-4.6`,
      providerID,
      api: {
        id: "glm-4.6",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "GLM 4.6",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  for (const providerID of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
    test(`${providerID} should set thinking cfg`, () => {
      const result = ProviderTransform.options({
        model: createModel(providerID),
        sessionID,
        providerOptions: {},
      })

      expect(result.thinking).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    })
  }
})

describe("ProviderTransform.providerOptions", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "test/test-model",
      providerID: "test",
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 64_000,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
      ...overrides,
    }) as any

  test("uses the anthropic sdk key for anthropic-package models", () => {
    const model = createModel({
      providerID: "bailian-token-plan-personal",
      api: {
        id: "qwen3.8-max",
        url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1",
        npm: "@ai-sdk/anthropic",
      },
    })

    expect(ProviderTransform.providerOptions(model, { effort: "max" })).toEqual({ anthropic: { effort: "max" } })
  })

  test("uses the alibaba sdk key for alibaba-package models", () => {
    const model = createModel({
      providerID: "alibaba",
      api: { id: "qwen-plus", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/alibaba" },
    })

    expect(ProviderTransform.providerOptions(model, { enableThinking: true })).toEqual({
      alibaba: { enableThinking: true },
    })
  })

  test("openai-compatible models ride the providerID key", () => {
    const model = createModel({ providerID: "deepseek" })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "max" })).toEqual({
      deepseek: { reasoningEffort: "max" },
    })
  })

  test("openai-compatible providerIDs are split on dots", () => {
    const model = createModel({ providerID: "example.ai" })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      example: { reasoningEffort: "high" },
    })
  })
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelV2.ID.make("deepseek/deepseek-chat"),
        providerID: ProviderV2.ID.make("deepseek"),
        api: {
          id: "deepseek-chat",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "DeepSeek Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: {
            field: "reasoning_content",
          },
        },
        cost: {
          input: 0.001,
          output: 0.002,
          cache: { read: 0.0001, write: 0.0002 },
        },
        limit: {
          context: 128000,
          output: 8192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Models without an interleaved reasoning field leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelV2.ID.make("custom/plain-model"),
        providerID: ProviderV2.ID.make("custom"),
        api: {
          id: "plain-model",
          url: "https://api.example.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "Plain Model",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: {
          input: 0.03,
          output: 0.06,
          cache: { read: 0.001, write: 0.002 },
        },
        limit: {
          context: 128000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - surrogate sanitization", () => {
  const model = {
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("replaces lone surrogates in model-visible text", () => {
    const lone = "\uD83D"
    const valid = "🚀"
    const sanitized = "�"
    const text = (label: string) => `${label} ${lone} and ${valid}`
    const expected = (label: string) => `${label} ${sanitized} and ${valid}`
    const msgs = [
      { role: "system", content: text("system") },
      { role: "user", content: text("user string") },
      {
        role: "user",
        content: [
          { type: "text", text: text("user text") },
          { type: "image", image: "data:image/png;base64,abcd" },
        ],
      },
      { role: "assistant", content: text("assistant string") },
      {
        role: "assistant",
        content: [
          { type: "text", text: text("assistant text") },
          { type: "reasoning", text: text("assistant reasoning") },
          { type: "tool-call", toolCallId: "call-1", toolName: "Read", input: { filePath: ".opencode/tool/emoji.ts" } },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "Read",
            output: { type: "text", value: text("assistant tool text") },
          },
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "Read",
            output: { type: "error-text", value: text("assistant tool error") },
          },
          {
            type: "tool-result",
            toolCallId: "call-4",
            toolName: "Read",
            output: { type: "content", value: [{ type: "text", text: text("assistant tool content") }] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-5",
            toolName: "Read",
            output: { type: "text", value: text("tool text") },
          },
          {
            type: "tool-result",
            toolCallId: "call-6",
            toolName: "Read",
            output: { type: "error-text", value: text("tool error") },
          },
          {
            type: "tool-result",
            toolCallId: "call-7",
            toolName: "Read",
            output: { type: "content", value: [{ type: "text", text: text("tool content") }] },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toBe(expected("system"))
    expect(result[1].content).toBe(expected("user string"))
    expect(result[2].content[0].text).toBe(expected("user text"))
    expect(result[3].content).toBe(expected("assistant string"))
    expect(result[4].content[0].text).toBe(expected("assistant text"))
    expect(result[4].content[1].text).toBe(expected("assistant reasoning"))
    expect(result[4].content[3].output.value).toBe(expected("assistant tool text"))
    expect(result[4].content[4].output.value).toBe(expected("assistant tool error"))
    expect(result[4].content[5].output.value[0].text).toBe(expected("assistant tool content"))
    expect(result[5].content[0].output.value).toBe(expected("tool text"))
    expect(result[5].content[1].output.value).toBe(expected("tool error"))
    expect(result[5].content[2].output.value[0].text).toBe(expected("tool content"))
    expect(result[2].content[1]).toEqual({ type: "image", image: "data:image/png;base64,abcd" })
  })
})

describe("ProviderTransform.message - empty image handling", () => {
  const mockModel = {
    id: "bailian-token-plan-personal/qwen3.8-max",
    providerID: "bailian-token-plan-personal",
    api: {
      id: "qwen3.8-max",
      url: "https://api.example.com/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Qwen3.8 Max",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })
})

describe("ProviderTransform.message - anthropic empty content filtering", () => {
  const anthropicModel = {
    id: "bailian-token-plan-personal/qwen3.8-max",
    providerID: "bailian-token-plan-personal",
    api: {
      id: "qwen3.8-max",
      url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1",
      npm: "@ai-sdk/anthropic",
    },
    name: "Qwen3.8 Max",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  // Anthropic automatic caching skips explicit cache breakpoints, so the assertions below see bare content.
  const automaticCaching = { cacheControl: { type: "ephemeral" } }

  test("filters out messages with empty string content", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("filters out empty text parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Hello" },
          { type: "text", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" })
  })

  test("filters out empty reasoning parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  test("removes entire message when all parts are empty", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("keeps non-text/reasoning parts even if text parts are empty", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "123", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({
      type: "tool-call",
      toolCallId: "123",
      toolName: "bash",
      input: { command: "ls" },
    })
  })

  test("keeps messages with valid text alongside empty parts", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "" },
          { type: "text", text: "Result" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching)

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "reasoning", text: "Thinking..." })
    expect(result[0].content[1]).toEqual({ type: "text", text: "Result" })
  })

  test("does not filter for non-anthropic providers", () => {
    const compatibleModel = {
      ...anthropicModel,
      providerID: "custom",
      api: {
        id: "plain-model",
        url: "https://api.example.com",
        npm: "@ai-sdk/openai-compatible",
      },
    }

    const msgs = [
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, compatibleModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("")
    expect(result[1].content).toHaveLength(1)
  })

  test("leaves valid anthropic assistant tool ordering unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I checked your home directory and looked for PDF files." },
          { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
          { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, automaticCaching) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content).toMatchObject([
      { type: "text", text: "I checked your home directory and looked for PDF files." },
      { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
      { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
    ])
  })
})

describe("ProviderTransform.message - providerOptions key remapping", () => {
  const createModel = (providerID: string, npm: string) =>
    ({
      id: `${providerID}/test-model`,
      providerID,
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm,
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  const remapped = (npm: string) => {
    const model = createModel("bailian-token-plan-personal", npm)
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        providerOptions: {
          "bailian-token-plan-personal": { someOption: "value" },
        },
      },
    ] as any[]
    return ProviderTransform.message(msgs, model, {})[0].providerOptions
  }

  test("anthropic-package providers remap providerID to the 'anthropic' key", () => {
    const options = remapped("@ai-sdk/anthropic")

    expect(options?.anthropic).toEqual({ someOption: "value" })
    expect(options?.["bailian-token-plan-personal"]).toBeUndefined()
  })

  test("alibaba-package providers remap providerID to the 'alibaba' key", () => {
    const options = remapped("@ai-sdk/alibaba")

    expect(options?.alibaba).toEqual({ someOption: "value" })
    expect(options?.["bailian-token-plan-personal"]).toBeUndefined()
  })

  test("openai-compatible providers keep their providerID key", () => {
    const options = remapped("@ai-sdk/openai-compatible")

    expect(options?.["bailian-token-plan-personal"]).toEqual({ someOption: "value" })
    expect(options?.anthropic).toBeUndefined()
  })
})

describe("ProviderTransform.message - cache control", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "bailian-token-plan-personal/qwen3.8-max",
      providerID: "bailian-token-plan-personal",
      api: {
        id: "qwen3.8-max",
        url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1",
        npm: "@ai-sdk/anthropic",
      },
      name: "Qwen3.8 Max",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 200_000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("anthropic-package models apply cache control at the message level", () => {
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, createModel(), {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      alibaba: {
        cacheControl: {
          type: "ephemeral",
        },
      },
    })
  })

  test("does not add explicit breakpoints when Anthropic automatic caching is enabled", () => {
    const model = createModel()
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, { cacheControl: { type: "ephemeral" } }) as any[]
    expect(result.every((message) => message.providerOptions === undefined)).toBe(true)
  })

  test("cacheTtl sets the anthropic cache_control ttl for anthropic-npm providers", () => {
    const model = createModel({
      providerID: "bailian",
      api: { id: "qwen3.8-max", url: "https://dashscope.aliyuncs.com/apps/anthropic", npm: "@ai-sdk/anthropic" },
      options: { cacheTtl: "1h" },
    })
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    for (const msg of result) {
      expect(msg.providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(msg.providerOptions.openaiCompatible.cache_control).toEqual({ type: "ephemeral" })
    }
    // Merged request options (agent / variant) win over the model default.
    const short = ProviderTransform.message(structuredClone(msgs), model, { cacheTtl: "5m" }) as any[]
    expect(short[0].providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  test("cacheTtl is ignored when invalid or for non-anthropic SDKs", () => {
    const msgs = () =>
      [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ] as any[]
    const anthropic = createModel({ options: { cacheTtl: "24h" } })
    expect(
      (ProviderTransform.message(msgs(), anthropic, {}) as any[])[0].providerOptions.anthropic.cacheControl,
    ).toEqual({
      type: "ephemeral",
    })
    const alibaba = createModel({
      providerID: "alibaba",
      api: { id: "qwen3.8-max", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/alibaba" },
      options: { cacheTtl: "1h" },
    })
    expect((ProviderTransform.message(msgs(), alibaba, {}) as any[])[0].providerOptions.alibaba.cacheControl).toEqual({
      type: "ephemeral",
    })
  })
})

describe("ProviderTransform sampling defaults - Qwen", () => {
  test.each(["Qwen3.8-27B", "qwen3-coder-30b-a3b-instruct"])('leaves sampling unset for "%s"', (id) => {
    const model = {
      id: `custom/${id}`,
      api: { id },
    } as any

    expect(ProviderTransform.temperature(model)).toBeUndefined()
    expect(ProviderTransform.topP(model)).toBeUndefined()
  })
})

describe("ProviderTransform sampling defaults - GLM", () => {
  test.each(["glm-4.6", "glm-4.7"])("defaults temperature to 1.0 for %s", (id) => {
    const model = { id: `custom/${id}`, api: { id } } as any

    expect(ProviderTransform.temperature(model)).toBe(1.0)
    expect(ProviderTransform.topP(model)).toBeUndefined()
  })

  test("leaves sampling unset for later GLM generations", () => {
    const model = { id: "custom/glm-5.3", api: { id: "glm-5.3" } } as any

    expect(ProviderTransform.temperature(model)).toBeUndefined()
  })
})

describe("ProviderTransform sampling defaults - DeepSeek", () => {
  const model = (providerID: string, id: string) =>
    ({
      id: `${providerID}/${id}`,
      providerID,
      api: { id },
    }) as any

  test.each([
    ["deepseek", "deepseek-v4-flash"],
    ["alibaba-cn", "deepseek-v4-flash-0731"],
    ["custom", "deepseek-v4-flash:0731"],
  ])("defaults top_p for %s/%s", (providerID, id) => {
    expect(ProviderTransform.temperature(model(providerID, id))).toBeUndefined()
    expect(ProviderTransform.topP(model(providerID, id))).toBe(0.95)
  })

  test.each([
    ["alibaba-cn", "deepseek-v4-flash"],
    ["custom", "deepseek-ai/DeepSeek-V4-Flash"],
  ])("preserves legacy defaults for %s/%s", (providerID, id) => {
    expect(ProviderTransform.temperature(model(providerID, id))).toBeUndefined()
    expect(ProviderTransform.topP(model(providerID, id))).toBeUndefined()
  })
})

describe("ProviderTransform.reasoningVariants", () => {
  const model = (reasoning_options: ModelsDev.Model["reasoning_options"]) => ({ reasoning_options }) as ModelsDev.Model
  const target = (npm: string, id = "test-model", family = "") =>
    ({
      id,
      providerID: "test",
      family,
      api: { id, npm, url: "" },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    }) as any

  test("respects explicitly empty reasoning options", () => {
    expect(ProviderTransform.reasoningVariants(model([]), target("@ai-sdk/openai-compatible"))).toEqual({})
  })

  test.each([
    ["@ai-sdk/anthropic", { effort: "high" }],
    ["@ai-sdk/openai-compatible", { reasoningEffort: "high" }],
  ])("converts effort for %s", (npm, expected) => {
    expect(ProviderTransform.reasoningVariants(model([{ type: "effort", values: ["high"] }]), target(npm))).toEqual({
      high: expected,
    })
  })

  test("uses explicit effort metadata for Anthropic-compatible models", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/anthropic", "qwen3.8-max"),
      ),
    ).toEqual({ high: { effort: "high" } })

    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["max"] }]),
        target("@ai-sdk/anthropic", "glm-5.3"),
      ),
    ).toEqual({ max: { effort: "max" } })
  })

  test.each([
    ["@ai-sdk/anthropic", { thinking: { type: "enabled", budgetTokens: 16_000 } }],
    ["@ai-sdk/alibaba", { enableThinking: true, thinkingBudget: 16_000 }],
  ])("converts token budgets for %s", (npm, high) => {
    const variants = ProviderTransform.reasoningVariants(model([{ type: "budget_tokens", min: 1_024 }]), target(npm))
    expect(variants?.high).toEqual(high)
    expect(Object.keys(variants ?? {})).toEqual(["high", "max"])
  })

  test("leaves token budgets unsupported on openai-compatible", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024 }]),
        target("@ai-sdk/openai-compatible"),
      ),
    ).toBeUndefined()
  })

  test("maps null effort to none", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: [null] }]),
        target("@ai-sdk/openai-compatible"),
      ),
    ).toEqual({ none: { reasoningEffort: "none" } })
  })

  test("converts toggle options for @ai-sdk/alibaba", () => {
    expect(ProviderTransform.reasoningVariants(model([{ type: "toggle" }]), target("@ai-sdk/alibaba"))).toEqual({
      none: { enableThinking: false },
      high: { enableThinking: true },
    })
  })

  test("generates bounded high and max token budgets", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024, max: 64_000 }]),
        target("@ai-sdk/anthropic"),
      ),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31_999 } },
    })
  })

  test("caps token budgets below the model output limit", () => {
    const anthropic = target("@ai-sdk/anthropic")
    anthropic.limit.output = 5_000
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "budget_tokens", min: 1_024, max: 64_000 }]), anthropic),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 2_500 } },
      max: { thinking: { type: "enabled", budgetTokens: 4_999 } },
    })
  })

  test("derives high and max budgets when models.dev omits max", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024 }]),
        target("@ai-sdk/anthropic", "qwen3.8-max"),
      ),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31_999 } },
    })
  })

  test("prefers effort options over token budgets", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([
          { type: "budget_tokens", min: 1_024, max: 64_000 },
          { type: "effort", values: ["low"] },
        ]),
        target("@ai-sdk/openai-compatible"),
      ),
    ).toEqual({ low: { reasoningEffort: "low" } })
  })

  test("leaves unsupported toggle options for heuristic fallback", () => {
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "toggle" }]), target("@ai-sdk/openai-compatible")),
    ).toBeUndefined()
  })

  test("does not invent effort controls for @ai-sdk/alibaba", () => {
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "effort", values: ["high"] }]), target("@ai-sdk/alibaba")),
    ).toEqual({})
  })
})

describe("ProviderTransform.variants", () => {
  const createMockModel = (overrides: Partial<any> = {}): any => ({
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.001,
      output: 0.002,
      cache: { read: 0.0001, write: 0.0002 },
    },
    limit: {
      context: 200_000,
      output: 64_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
  })

  test("returns empty object when model has no reasoning capabilities", () => {
    const model = createMockModel({
      capabilities: { reasoning: false },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("deepseek returns empty object", () => {
    const model = createMockModel({
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("minimax returns empty object", () => {
    const model = createMockModel({
      id: "minimax/minimax-model",
      providerID: "minimax",
      api: {
        id: "minimax-model",
        url: "https://api.minimax.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("glm returns empty object", () => {
    const model = createMockModel({
      id: "glm/glm-4",
      providerID: "glm",
      api: {
        id: "glm-4",
        url: "https://api.glm.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("glm-5.2 returns native effort variants for openai-compatible providers", () => {
    const model = createMockModel({
      id: "zhipuai/glm-5.2",
      providerID: "zhipuai",
      api: {
        id: "glm-5.2",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("recognizes GLM-5.2 provider model IDs", () => {
    for (const id of ["accounts/fireworks/models/glm-5p2", "zai-org-glm-5-2", "umans-glm-5.2"]) {
      const model = createMockModel({
        id: `test/${id}`,
        api: {
          id,
          url: "https://api.test.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      expect(ProviderTransform.variants(model)).toEqual({
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      })
    }
  })

  test("recognizes GLM-5.2 from the API ID when the configured model ID is an alias", () => {
    const model = createMockModel({
      id: "custom/my-glm",
      api: {
        id: "accounts/fireworks/models/glm-5p2",
        url: "https://api.fireworks.ai/inference/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("glm-5.2 returns effort variants for anthropic-compatible providers", () => {
    const model = createMockModel({
      id: "zai-coding-plan/glm-5.2",
      providerID: "zai-coding-plan",
      api: {
        id: "glm-5.2",
        url: "https://api.z.ai/api/anthropic",
        npm: "@ai-sdk/anthropic",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { effort: "high" },
      max: { effort: "max" },
    })
  })

  test("glm-5.3 returns effort variants for anthropic-compatible providers", () => {
    const model = createMockModel({
      id: "zhipuai-coding-plan/glm-5.3",
      providerID: "zhipuai-coding-plan",
      api: {
        id: "glm-5.3",
        url: "https://api.bigmodel.cn/api/anthropic",
        npm: "@ai-sdk/anthropic",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { effort: "high" },
      max: { effort: "max" },
    })
  })

  test("glm-5.2 on an unsupported package yields no variants", () => {
    const model = createMockModel({
      id: "test/glm-5.2",
      api: {
        id: "glm-5.2",
        url: "https://api.test.com",
        npm: "@ai-sdk/alibaba",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({})
  })

  describe("@ai-sdk/openai-compatible", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "custom-provider/custom-model",
        providerID: "custom-provider",
        api: {
          id: "custom-model",
          url: "https://api.custom.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("deepseek-v4 models also get a max effort", () => {
      const model = createMockModel({
        id: "deepseek/deepseek-v4-flash",
        providerID: "deepseek",
        api: {
          id: "deepseek-v4-flash",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.max).toEqual({ reasoningEffort: "max" })
    })
  })

  describe("@ai-sdk/anthropic", () => {
    test("returns high and max with thinking config", () => {
      const model = createMockModel({
        id: "custom-provider/custom-reasoner",
        providerID: "custom-provider",
        api: {
          id: "custom-reasoner",
          url: "https://api.custom.com/anthropic",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })
  })

  describe("ProviderTransform.smallOptions", () => {
    test("uses the weakest generated variant", () => {
      const model = createMockModel({
        variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
      })
      expect(ProviderTransform.smallOptions(model)).toEqual({ reasoningEffort: "low" })
    })

    test("is empty when the model has no variants", () => {
      expect(ProviderTransform.smallOptions(createMockModel({ variants: {} }))).toEqual({})
    })
  })
})
