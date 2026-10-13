import type { SessionStatsInfo, SessionStatsModelUsage } from "@opencode/client"
import { Locale } from "./locale"

export type UsageRow = { readonly label: string; readonly value: string }

/**
 * The Context window section: the window's current reading, then how many times this
 * session has compacted. `stats.compactions` is deliberately not used — it sums the
 * whole subagent tree, and a subagent compacts its own window, not the one this
 * section describes. Zero is shown rather than omitted: "never compacted" is the
 * reading the row exists to give, and the count must not vanish exactly when it is 0.
 */
export function contextWindowRows(
  usage: { readonly tokens: number; readonly limit?: number; readonly percent?: number } | undefined,
  compactions: number | undefined,
): UsageRow[] {
  const rows: UsageRow[] = []
  if (usage) {
    rows.push({ label: "Context tokens", value: Locale.number(usage.tokens) })
    rows.push({
      label: "Context window",
      value: usage.limit ? Locale.number(usage.limit) : "window size unknown for this model",
    })
    if (usage.percent !== undefined) rows.push({ label: "Context used", value: contextBar(usage.percent) })
  }
  if (compactions !== undefined) rows.push({ label: "Compactions", value: Locale.number(compactions) })
  return rows
}

function contextBar(percent: number) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${percent}%`
}

/** Cost strings keep tiny amounts visible instead of rounding them to $0.00. */
export function cost(value: number) {
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
}

/** `provider/model`, with `#variant` when the session recorded one — variants price and count separately. */
export function modelLabel(model: SessionStatsModelUsage["model"]) {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

/**
 * The Usage block: every token class the database recorded, then the recorded spend.
 * All five classes are always listed, zero included, so the shape does not shift between sessions.
 */
export function usageTotals(stats: SessionStatsInfo): UsageRow[] {
  return [
    { label: "Input tokens", value: Locale.number(stats.tokens.input) },
    { label: "Output tokens", value: Locale.number(stats.tokens.output) },
    { label: "Reasoning tokens", value: Locale.number(stats.tokens.reasoning) },
    { label: "Cache read tokens", value: Locale.number(stats.tokens.cache.read) },
    { label: "Cache write tokens", value: Locale.number(stats.tokens.cache.write) },
    { label: "Cost", value: cost(stats.cost) },
  ]
}

/**
 * Activity counts: what happened, not what it cost. Compaction counts are not activity that
 * belongs here: the report carries one under the Context window section, counting the
 * session's own compactions against the loaded message window's own scope.
 */
export function usageActivity(stats: SessionStatsInfo): UsageRow[] {
  const rows: UsageRow[] = [
    { label: "Prompts", value: Locale.number(stats.prompts) },
    { label: "Steps", value: Locale.number(stats.steps) },
  ]
  const tools = stats.tools.mode === "none" ? undefined : stats.tools.totals
  if (tools && tools.calls > 0) {
    rows.push({
      label: "Tool calls",
      value: `${Locale.number(tools.calls)}${tools.failed > 0 ? ` · ${Locale.number(tools.failed)} failed` : ""}`,
    })
  }
  if (stats.sessions > 1 || stats.subagents > 0) {
    rows.push({
      label: "Scope",
      value: `${stats.sessions} session${stats.sessions === 1 ? "" : "s"} · ${stats.subagents} subagent${
        stats.subagents === 1 ? "" : "s"
      }`,
    })
  }
  return rows
}

/** Per-model rows; the sort puts the biggest spender first so the list reads as a ranking. */
export function usageModels(stats: SessionStatsInfo): UsageRow[] {
  return stats.models
    .toSorted((a, b) => b.cost - a.cost || b.steps - a.steps || modelLabel(a.model).localeCompare(modelLabel(b.model)))
    .map((entry) => {
      const tokens =
        entry.tokens.input + entry.tokens.output + entry.tokens.reasoning + entry.tokens.cache.read + entry.tokens.cache.write
      return {
        label: modelLabel(entry.model),
        value: `${cost(entry.cost)} · ${entry.steps} step${entry.steps === 1 ? "" : "s"} · ${Locale.number(tokens)} tokens`,
      }
    })
}

/**
 * Models that consumed tokens but recorded no cost. Subscription plans carry no per-token
 * prices in the registry, so their recorded cost is 0; the dialog says so instead of
 * implying the usage was free.
 */
export function zeroCostModels(stats: SessionStatsInfo) {
  return stats.models.filter(
    (entry) => entry.cost === 0 && entry.tokens.input + entry.tokens.output + entry.tokens.reasoning > 0,
  )
}

/** The zero-cost sentence, or undefined when every model recorded a price. */
export function zeroCostNote(stats: SessionStatsInfo) {
  const models = zeroCostModels(stats)
  if (models.length === 0) return undefined
  return `Subscription plans have no per-token prices, so ${models
    .map((entry) => modelLabel(entry.model))
    .join(", ")} record $0 — not a measurement of what was actually billed.`
}

/** Where the figures come from: recorded step usage, not the loaded message window. */
export const USAGE_SOURCE_NOTE =
  "Source: recorded step usage from the database — lifetime totals for this session and its subagent tree, not the loaded message window."

/** What a cost number is: registry list prices, not an invoice. */
export const USAGE_ESTIMATE_NOTE =
  "Note: flat-rate and subscription plans carry no per-token prices; their spend is estimated at canonical registry list prices, not billed amounts."
