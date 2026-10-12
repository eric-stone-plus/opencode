import type { SessionStatsInfo, SessionStatsModelUsage } from "@opencode/client"
import { Locale } from "./locale"

export type UsageRow = { readonly label: string; readonly value: string }

/** Cost strings keep tiny amounts visible instead of rounding them to $0.00. */
export function cost(value: number) {
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
}

export function tokenSummary(tokens: SessionStatsInfo["tokens"]) {
  const parts = [`${Locale.number(tokens.input)} in`, `${Locale.number(tokens.output)} out`]
  if (tokens.reasoning) parts.push(`${Locale.number(tokens.reasoning)} reasoning`)
  if (tokens.cache.read) parts.push(`${Locale.number(tokens.cache.read)} cache read`)
  if (tokens.cache.write) parts.push(`${Locale.number(tokens.cache.write)} cache write`)
  return parts.join(" · ")
}

/** The headline block: cost, tokens, and the activity counts of the session tree. */
export function usageTotals(stats: SessionStatsInfo): UsageRow[] {
  const rows: UsageRow[] = [
    { label: "Cost", value: cost(stats.cost) },
    { label: "Tokens", value: tokenSummary(stats.tokens) },
    {
      label: "Activity",
      value: `${stats.prompts} prompt${stats.prompts === 1 ? "" : "s"} · ${stats.steps} step${
        stats.steps === 1 ? "" : "s"
      } · ${stats.compactions} compaction${stats.compactions === 1 ? "" : "s"}`,
    },
  ]
  if (stats.sessions > 1 || stats.subagents > 0) {
    rows.push({
      label: "Scope",
      value: `${stats.sessions} session${stats.sessions === 1 ? "" : "s"}${
        stats.subagents > 0 ? ` · ${stats.subagents} subagent${stats.subagents === 1 ? "" : "s"}` : ""
      }`,
    })
  }
  if (stats.tools.mode !== "none" && stats.tools.totals.calls > 0) {
    const failed = stats.tools.totals.failed
    rows.push({
      label: "Tools",
      value: `${stats.tools.totals.calls} call${stats.tools.totals.calls === 1 ? "" : "s"}${
        failed > 0 ? ` · ${failed} failed` : ""
      }`,
    })
  }
  return rows
}

export function modelLabel(model: SessionStatsModelUsage["model"]) {
  return `${model.providerID}/${model.id}`
}

/** Per-model rows; the sort puts the biggest spender first so the list reads as a ranking. */
export function usageModels(stats: SessionStatsInfo): Array<{ label: string; detail: string; cost: string }> {
  return stats.models
    .toSorted((a, b) => b.cost - a.cost || b.steps - a.steps || modelLabel(a.model).localeCompare(modelLabel(b.model)))
    .map((entry) => ({
      label: modelLabel(entry.model),
      detail:
        `${count(entry.steps, "step")} · ${Locale.number(entry.tokens.input + entry.tokens.output + entry.tokens.reasoning)} tokens` +
        (entry.compactions > 0 ? ` · ${count(entry.compactions, "compaction")}` : ""),
      cost: cost(entry.cost),
    }))
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`

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
