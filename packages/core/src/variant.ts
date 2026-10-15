export * as Variant from "./variant.js"

import { topVariant } from "@opencode/util/variant"
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

/**
 * The variant a request runs with (2026-10-10 policy, ported from the V1
 * fork): an explicit pick is honored — unknown ones still fail in
 * `withVariant` — while the unset variant and the `default` sentinel resolve
 * to the ladder's top rung, so effort never falls to the provider's
 * "default" by omission. A ladder that defines a real `default` tier keeps
 * the explicit pick's usual meaning when that tier is named directly.
 */
export function effective(model: Model.Info, variant: Model.VariantID | undefined): Model.VariantID | undefined {
  if (variant !== undefined && variant !== "default") return variant
  const ladder = model.variants?.map((item) => item.id) ?? []
  // A real "default" tier (groq qwen3-32b's "none"|"default" axis) makes the
  // sentinel an explicit pick of that tier, exactly as V1 honored it.
  if (variant === "default" && ladder.some((id) => String(id) === "default"))
    return Model.VariantID.make("default")
  return topVariant(ladder)
}

const EFFORTS = ["low", "medium", "high"]
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" }
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000

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

const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  "@opencode/ai/providers/openai-compatible": openaiChat,
  "@opencode/ai/providers/deepseek": deepseekChat,
  "@opencode/ai/providers/anthropic": anthropicMessages,
}
