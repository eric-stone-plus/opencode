export * as Variant from "./variant.js"

import { Model } from "./model.js"

export type Support =
  | { readonly type: "effort"; readonly values?: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }

type Variants = Model.Info["variants"]
type Overlay = Omit<Variants[number], "id">

type Protocol = (model: Model.Info, support: Support) => Variants

export function resolve(model: Model.Info, supports: readonly Support[] = [{ type: "effort" }]): Variants {
  const protocol = model.package === undefined ? undefined : PROTOCOLS[model.package]
  if (!protocol) return []
  const toggle = supports.some((support) => support.type === "toggle") ? protocol(model, { type: "toggle" }) : []
  const effort = supports.find((support) => support.type === "effort")
  const budget = supports.find((support) => support.type === "budget_tokens")
  const main = effort ? protocol(model, effort) : budget ? protocol(model, budget) : toggle
  const variants = [...toggle.filter((variant) => variant.id === "none"), ...main]
  return variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index)
}

const EFFORTS = ["low", "medium", "high"]
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" }
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000
// Alibaba thinking budget variants stay under 64k instead of reaching the model's whole output limit.
const ALIBABA_THINKING_BUDGET_MAX = 64_000

const variant = (id: string, overlay: Overlay): Variants[number] => ({ id: Model.VariantID.make(id), ...overlay })

const efforts = (values: readonly string[], spell: (effort: string) => Overlay): Variants =>
  values.map((effort) => variant(effort, spell(effort)))

const toggle = (off: Overlay, on: Overlay): Variants => [variant("none", off), variant("thinking", on)]

function budgets(
  model: Model.Info,
  support: Extract<Support, { type: "budget_tokens" }>,
  spell: (tokens: number) => Overlay,
  ceiling = model.limit.output,
): Variants {
  const maximum = Math.min(support.max ?? ceiling - 1, model.limit.output - 1, ceiling - 1)
  if (maximum <= 0) return []
  const high = Math.min(Math.max(support.min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  return [variant("high", spell(high)), variant("max", spell(maximum))]
}

const modelID = (model: Model.Info) => model.modelID ?? model.id

function claudeInfo(model: Model.Info) {
  const id = modelID(model)
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id)
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    family,
    major,
    minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === "fable" || family === "mythos" || id.toLowerCase().includes("mythos-preview"),
  }
}

function manualThinking(model: Model.Info): Overlay | undefined {
  const tokens = Math.min(16_000, model.limit.output - 1)
  if (tokens < 1024) return
  return { settings: { thinking: { type: "enabled", budgetTokens: tokens } } }
}

const openaiChat: Protocol = (_, support) => {
  if (support.type !== "effort") return []
  return efforts(support.values ?? EFFORTS, (effort) => ({ settings: { reasoningEffort: effort } }))
}

const deepseekChat: Protocol = (_, support) => {
  switch (support.type) {
    case "effort":
      return efforts(support.values ?? ["low", "high", "max"], (effort) => {
        if (effort === "none") return { body: { thinking: { type: "disabled" } } }
        return { settings: { reasoningEffort: effort }, body: { thinking: { type: "enabled" } } }
      })
    case "toggle":
      return toggle({ body: { thinking: { type: "disabled" } } }, { body: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      return []
  }
}

const alibabaChat: Protocol = (model, support) => {
  const id = modelID(model).toLowerCase()
  const fixed =
    id.includes("-thinking") || id.includes("qwq") || id.includes("deepseek-r1") || id.includes("minimax-m2")
  switch (support.type) {
    case "effort": {
      if (fixed && support.values === undefined) return []
      const hosted = id.includes("glm") || id.includes("deepseek")
      const values = support.values ?? (hosted ? ["high", "max"] : ["low", "medium", "xhigh"])
      return efforts(values, (effort) => {
        if (effort === "none") return { settings: { enableThinking: false } }
        return { settings: { enableThinking: true, reasoningEffort: effort } }
      })
    }
    case "toggle":
      return toggle({ settings: { enableThinking: false } }, { settings: { enableThinking: true } })
    case "budget_tokens":
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { enableThinking: true, thinkingBudget: tokens } }),
        ALIBABA_THINKING_BUDGET_MAX,
      )
  }
}

const zaiChat: Protocol = (model, support) => {
  const id = modelID(model).toLowerCase()
  const version = /glm-?(\d+)(?:(?:[.-]|p)(\d+))?/.exec(id)
  const major = Number(version?.[1])
  const minor = Number(version?.[2] ?? 0)
  const coding = model.package?.includes("zai-coding-plan") ?? false
  const latest = coding || !Number.isFinite(major) || major > 5 || (major === 5 && minor >= 3)
  const effort = major === 5 && minor === 2
  if (support.type === "toggle" || (!latest && !effort && support.type === "effort" && support.values === undefined)) {
    if (latest) return []
    return toggle(
      { settings: { thinking: { type: "disabled" } } },
      { settings: { thinking: { type: "enabled", clear_thinking: false } } },
    )
  }
  if (support.type !== "effort") return []
  return efforts(support.values ?? (latest ? ["low", "high", "max"] : ["high", "max"]), (value) => {
    if (value === "none" || value === "minimal") return { settings: { thinking: { type: "disabled" } } }
    return {
      settings: { thinking: { type: "enabled", clear_thinking: false }, reasoningEffort: value },
    }
  })
}

const anthropicMessages: Protocol = (model, support) => {
  const info = claudeInfo(model)
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5
  switch (support.type) {
    case "effort": {
      if (info.manual && !opus45) return anthropicMessages(model, { type: "budget_tokens", min: 1024 })
      const thinking = opus45 ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } }
      if (!thinking) return []
      const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, "max"] : [...EFFORTS, "xhigh", "max"]
      const values = (support.values ?? defaults).filter((effort) => !info.always || effort !== "none")
      return efforts(values, (effort) =>
        effort === "none"
          ? { settings: { thinking: { type: "disabled" } } }
          : { settings: { ...thinking.settings, effort } },
      )
    }
    case "toggle": {
      if (info.always) return []
      const thinking = info.manual ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } }
      if (!thinking) return []
      return toggle({ settings: { thinking: { type: "disabled" } } }, thinking)
    }
    case "budget_tokens":
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        ANTHROPIC_OUTPUT_TOKEN_MAX,
      )
  }
}

const alibabaMessages: Protocol = (model, support) => {
  const id = modelID(model).toLowerCase()
  switch (support.type) {
    case "effort": {
      const hosted = id.includes("glm") || id.includes("deepseek")
      const values = support.values ?? (hosted ? ["high", "max"] : ["low", "medium", "xhigh"])
      return efforts(values, (effort) => {
        if (effort === "none") return { settings: { thinking: { type: "disabled" } } }
        return { settings: { thinking: { type: "enabled" }, effort } }
      })
    }
    case "toggle":
      return toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      return budgets(
        model,
        support,
        (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }),
        ALIBABA_THINKING_BUDGET_MAX,
      )
  }
}

const zaiMessages: Protocol = (model, support) => {
  const id = modelID(model).toLowerCase()
  const forced = id.includes("glm-5.3") || id.includes("glm-5-3") || id.includes("glm-5p3")
  switch (support.type) {
    case "effort":
      return efforts(support.values ?? (forced ? ["low", "high", "max"] : ["high", "max"]), (effort) => ({
        settings: {
          thinking: { type: effort === "none" || effort === "minimal" ? "disabled" : "enabled" },
          effort,
        },
      }))
    case "toggle":
      return forced
        ? []
        : toggle({ settings: { thinking: { type: "disabled" } } }, { settings: { thinking: { type: "enabled" } } })
    case "budget_tokens":
      return []
  }
}

const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  "@opencode/ai/providers/openai-compatible": openaiChat,
  "@opencode/ai/providers/alibaba/chat": alibabaChat,
  "@opencode/ai/providers/deepseek": deepseekChat,
  "@opencode/ai/providers/zai/chat": zaiChat,
  "@opencode/ai/providers/zai-coding-plan/chat": zaiChat,

  "@opencode/ai/providers/anthropic": anthropicMessages,
  "@opencode/ai/providers/alibaba/messages": alibabaMessages,
  "@opencode/ai/providers/zai-coding-plan/messages": zaiMessages,
}
