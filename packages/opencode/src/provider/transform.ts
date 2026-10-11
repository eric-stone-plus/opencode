import type { ModelMessage, ToolResultPart } from "ai"
import { mergeDeep, unique } from "remeda"
import { glmFaceOf, glmNative } from "./glm"
import type * as Provider from "./provider"
import type * as ModelsDev from "@opencode-ai/core/models-dev"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return "anthropic"
    case "@ai-sdk/alibaba":
      return "alibaba"
  }
  return undefined
}

// TODO: fix this stupid inefficient dogshit function
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  const sanitizeToolResultOutput = (content: ToolResultPart) => {
    if (content.output.type === "text" || content.output.type === "error-text") {
      content.output.value = sanitizeSurrogates(content.output.value)
    }
    if (content.output.type === "content") {
      content.output.value = content.output.value.map((item) => {
        if (item.type === "text") {
          item.text = sanitizeSurrogates(item.text)
        }
        return item
      })
    }
    return content
  }

  msgs = msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })

  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.anthropic?.signature != null ||
              part.providerOptions?.anthropic?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  // Deepseek requires all assistant messages to have reasoning on them
  if (model.api.id.toLowerCase().includes("deepseek")) {
    msgs = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg
      if (Array.isArray(msg.content)) {
        if (msg.content.some((part) => part.type === "reasoning")) return msg
        return { ...msg, content: [...msg.content, { type: "reasoning", text: "" }] }
      }
      return {
        ...msg,
        content: [
          ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
          { type: "reasoning" as const, text: "" },
        ],
      }
    })
  }

  if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages.
        // Always set the field even when empty — some providers (e.g. DeepSeek) may return empty
        // reasoning_content which still needs to be sent back in subsequent requests.
        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...msg.providerOptions?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }

      return msg
    })
  }

  return msgs
}

// `cacheTtl` ("5m" | "1h") in the model options sets the Anthropic cache_control
// TTL for anthropic-npm providers; multi-hour runs with gaps longer than five
// minutes keep their prefix warm with "1h". Other SDK keys keep the default.
function cacheTtl(model: Provider.Model, options: Record<string, unknown>) {
  if (model.api.npm !== "@ai-sdk/anthropic") return
  const ttl = options.cacheTtl ?? model.options.cacheTtl
  return ttl === "5m" || ttl === "1h" ? ttl : undefined
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown> = {}): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)
  const ttl = cacheTtl(model, options)

  const providerOptions = {
    anthropic: {
      cacheControl: ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

function mapProviderOptions(
  msgs: ModelMessage[],
  transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
) {
  return msgs.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
    return {
      ...msg,
      providerOptions: transform(msg.providerOptions),
      content: msg.content.map((part) =>
        part.type === "tool-approval-request" || part.type === "tool-approval-response"
          ? part
          : { ...part, providerOptions: transform(part.providerOptions) },
      ),
    } as typeof msg
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  const usesAnthropicAutomaticCaching = options.cacheControl !== undefined && model.api.npm === "@ai-sdk/anthropic"
  if ((model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/alibaba") && !usesAnthropicAutomaticCaching) {
    msgs = applyCaching(msgs, model, options)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = mapProviderOptions(msgs, remap)
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  const id = model.api.id.toLowerCase()
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.api.id.toLowerCase()
  if (
    ["deepseek-v4-flash-0731", "deepseek-v4-flash:0731"].some((name) => id.includes(name)) ||
    (id.includes("deepseek-v4-flash") && model.providerID === "deepseek")
  ) {
    return 0.95
  }
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  // GLM-5.3 exposes the same thinking effort controls as GLM-5.2 on every transport below.
  const glm52Or53 = ["glm-5.2", "glm-5-2", "glm-5p2", "glm-5.3", "glm-5-3", "glm-5p3"].some(
    (name) => id.includes(name) || model.api.id.toLowerCase().includes(name),
  )
  if (glm52Or53 && model.api.npm === "@ai-sdk/openai-compatible") {
    return {
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    }
  }
  if (glm52Or53 && model.api.npm === "@ai-sdk/anthropic") {
    // Source the effort ladder from the GLM capability table when the api id
    // parses; aliased ids (glm-5p2 and friends) keep the legacy literal pair.
    const spec = glmNative(
      { modelID: model.api.id, reasoning: model.capabilities.reasoning },
      glmFaceOf(model.api.npm),
    )
    const efforts = spec && spec.generation === "5.x" ? spec.efforts : (["high", "max"] as const)
    return Object.fromEntries(efforts.map((effort) => [effort, { effort }]))
  }
  if (
    id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    (id.includes("glm") && !glm52Or53) ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen")
  )
    return {}

  switch (model.api.npm) {
    case "@ai-sdk/openai-compatible": {
      const efforts = [...WIDELY_SUPPORTED_EFFORTS]
      if (model.api.id.toLowerCase().includes("deepseek-v4")) {
        efforts.push("max")
      }
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }
  }
  return {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  if (input.model.api.npm === "@ai-sdk/anthropic") {
    result["toolStreaming"] = false
  }

  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  const modelId = input.model.api.id.toLowerCase()

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.providerOptions?.setCacheKey !== false) {
    // DeepSeek documents `prompt_cache_key` as the prefix-cache affinity
    // hint on its OpenAI-compatible API. Scoped to the deepseek provider id:
    // cache-key semantics of other openai-compatible endpoints are unverified.
    if (input.model.providerID === "deepseek" && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["prompt_cache_key"] = input.sessionID
    } else if (input.providerOptions?.setCacheKey === true) {
      result["promptCacheKey"] = input.sessionID
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  return Object.values(model.variants ?? {})[0] ?? {}
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  // Harness-only knobs that ride `model.options` for config convenience must
  // never reach the wire: the openai-compatible SDK spreads unrecognized
  // providerOptions keys straight into the JSON body. workingContextCap is
  // consumed by session/overflow.ts only — strip before normalization copies.
  const { workingContextCap: _workingContextCap, ...wireOptions } = options

  // @ai-sdk/openai-compatible resolves providerOptionsName by splitting the provider name on "."
  // (e.g. "example.ai" -> "example"), so the key we write must match the key it reads.
  const key =
    sdkKey(model.api.npm) ??
    (model.api.npm === "@ai-sdk/openai-compatible" ? model.providerID.split(".")[0] : model.providerID)
  return { [key]: wireOptions }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax?: number): number {
  // Persist per-model budgets in config: terminal/daemon environments often
  // predate changes to OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX.
  const configured = model.options.maxOutputTokens
  const maximum =
    outputTokenMax ??
    (typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
      ? configured
      : OUTPUT_TOKEN_MAX)
  return Math.min(model.limit.output, maximum) || maximum
}

export function reasoningVariants(model: ModelsDev.Model, target: Provider.Model): Provider.Model["variants"] {
  const options = model.reasoning_options
  if (options === undefined) return
  if (options.length === 0) return {}

  const effort = options.find((option) => option.type === "effort")
  if (effort) return effortVariants(target, effort.values)

  const toggle = options.some((option) => option.type === "toggle")
  const budget = options.find((option) => option.type === "budget_tokens")
  if (!budget) return toggle ? nonEmptyVariants(reasoningToggle(target)) : undefined

  return nonEmptyVariants({
    ...(toggle ? reasoningToggle(target) : {}),
    ...budgetVariants(target, budget.min, budget.max),
  })
}

function effortVariants(model: Provider.Model, values: readonly unknown[]) {
  return Object.fromEntries(
    values.flatMap((value) => {
      const id = (() => {
        if (value === null) return "none"
        if (typeof value === "string") return value
      })()
      if (id === undefined) return []
      const settings = reasoningEffort(model, id)
      return settings ? [[id, settings]] : []
    }),
  )
}

function budgetVariants(model: Provider.Model, min?: number, max?: number) {
  const maximum = Math.min(max ?? OUTPUT_TOKEN_MAX - 1, model.limit.output - 1, OUTPUT_TOKEN_MAX - 1)
  if (maximum <= 0) return {}
  const high = Math.min(Math.max(min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  return Object.fromEntries(
    [
      { id: "high", budget: high },
      { id: "max", budget: maximum },
    ].flatMap((item) => {
      const settings = reasoningBudget(model, item.budget)
      return settings ? [[item.id, settings]] : []
    }),
  )
}

function nonEmptyVariants(variants: NonNullable<Provider.Model["variants"]>): Provider.Model["variants"] {
  return Object.keys(variants).length > 0 ? variants : undefined
}

function reasoningToggle(model: Provider.Model): NonNullable<Provider.Model["variants"]> {
  if (model.api.npm === "@ai-sdk/alibaba")
    return {
      none: { enableThinking: false },
      high: { enableThinking: true },
    }
  return {}
}

function reasoningEffort(model: Provider.Model, effort: string) {
  switch (model.api.npm) {
    case "@ai-sdk/anthropic":
      return { effort }
    case "@ai-sdk/openai-compatible":
      return { reasoningEffort: effort }
    case "@ai-sdk/alibaba":
      return
  }
}

function reasoningBudget(model: Provider.Model, budget: number) {
  switch (model.api.npm) {
    case "@ai-sdk/anthropic":
      return { thinking: { type: "enabled", budgetTokens: budget } }
    case "@ai-sdk/alibaba":
      return { enableThinking: true, thinkingBudget: budget }
    case "@ai-sdk/openai-compatible":
      return
  }
}

export * as ProviderTransform from "./transform"
