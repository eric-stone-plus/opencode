export * as ForkPricing from "./pricing.js"

import { Money } from "@opencode/schema/money"
import type { Model } from "@opencode/schema/model"

/**
 * Price matching for the raw catalog, ported from the V1 fork's Pricing.match.
 * Never invents prices: an explicit zero without any nonzero match stays
 * unpriced. Cascade: declared cost, then the `canonical_model_id` chain, then
 * votes from same-named models across providers (majority terminal, median
 * fallback). The subscription-plan rows carry all-zero costs, so the cascade is
 * what lets a plan model show the price of the flagship model it aliases.
 */

type Cost = {
  readonly input?: number
  readonly output?: number
  readonly cache_read?: number
  readonly cache_write?: number
  readonly tiers?: readonly (Cost & { readonly tier: { readonly type: "context"; readonly size: number } })[]
  readonly context_over_200k?: Cost
}

type Row = { readonly cost?: Cost; readonly canonical_model_id?: string }

/** The raw catalog shape shared by the bundled snapshot and every other source. */
export type Registry = Record<string, { readonly models: Record<string, Row> }>

export type Match = { readonly cost: Cost; readonly source: "declared" | "canonical" | "cross-provider" }

/** True when any rate anywhere in the row is above zero — the catalog has a price for it. */
export const hasPrice = (cost: Cost | undefined): cost is Cost => {
  if (cost === undefined) return false
  const single = (value: Cost) =>
    (value.input ?? 0) > 0 ||
    (value.output ?? 0) > 0 ||
    (value.cache_read ?? 0) > 0 ||
    (value.cache_write ?? 0) > 0
  return (
    single(cost) ||
    (cost.tiers ?? []).some(single) ||
    (cost.context_over_200k !== undefined && single(cost.context_over_200k))
  )
}

function ownRow(models: Record<string, Row>, modelID: string) {
  const exact = models[modelID]
  if (exact) return { key: modelID, row: exact }
  // On a case miss accept a row equal under toLowerCase, but only when exactly
  // one exists: a case-collision pair must not be guessed between.
  const [variant] = Object.keys(models).filter((key) => key.toLowerCase() === modelID.toLowerCase())
  if (variant === undefined) return undefined
  const row = models[variant]
  return row === undefined ? undefined : { key: variant, row }
}

function lookup(registry: Registry, key: string) {
  const split = key.indexOf("/")
  if (split < 0) return undefined
  const row = registry[key.slice(0, split)]?.models[key.slice(split + 1)]
  return row === undefined ? undefined : { key, row }
}

/** Follows `canonical_model_id` at most three hops with a cycle guard; a self-canonical row is a terminal. */
function walk(registry: Registry, row: Row, ownKey: string) {
  const visited = new Set([ownKey])
  const hop = (
    key: string | undefined,
    depth: number,
    priced: Cost | undefined,
    terminal: string,
  ): { terminal: string; priced: Cost | undefined } => {
    if (key === undefined || depth >= 3 || visited.has(key)) return { terminal, priced }
    const found = lookup(registry, key)
    if (found === undefined) return { terminal, priced }
    visited.add(key)
    return hop(
      found.row.canonical_model_id,
      depth + 1,
      priced ?? (hasPrice(found.row.cost) ? found.row.cost : undefined),
      key,
    )
  }
  return hop(row.canonical_model_id, 0, undefined, ownKey)
}

type Candidate = { readonly providerID: string; readonly key: string; readonly row: Row }

function addTo(map: Map<string, Candidate[]>, key: string, candidate: Candidate) {
  const list = map.get(key)
  if (list) list.push(candidate)
  else map.set(key, [candidate])
}

function crossProviderVotes(registry: Registry, candidates: readonly Candidate[]): Match | undefined {
  const byTerminal = new Map<string, Set<string>>()
  const effective: Cost[] = []
  for (const candidate of candidates) {
    const followed = walk(registry, candidate.row, `${candidate.providerID}/${candidate.key}`)
    const cost = hasPrice(candidate.row.cost) ? candidate.row.cost : followed.priced
    if (cost === undefined) continue
    effective.push(cost)
    const voters = byTerminal.get(followed.terminal) ?? new Set<string>()
    voters.add(candidate.providerID)
    byTerminal.set(followed.terminal, voters)
  }
  const ranked = [...byTerminal.entries()]
    .map(([id, voters]) => ({ id, count: voters.size }))
    .sort((a, b) => b.count - a.count)
  const winner = ranked[0] !== undefined && ranked[0].count > (ranked[1]?.count ?? 0) ? ranked[0] : undefined
  if (winner !== undefined) {
    const row = lookup(registry, winner.id)
    if (row !== undefined && hasPrice(row.row.cost)) return { cost: row.row.cost, source: "cross-provider" }
  }
  if (effective.length === 0) return undefined
  // Median by base input rate over the observations themselves, lower middle on
  // an even count, so the result is always an observed cost object.
  const sorted = [...effective].sort((a, b) => (a.input ?? 0) - (b.input ?? 0))
  const median = sorted[Math.floor((sorted.length - 1) / 2)]
  return median === undefined ? undefined : { cost: median, source: "cross-provider" }
}

function crossProvider(registry: Registry, modelID: string): Match | undefined {
  const exact = new Map<string, Candidate[]>()
  const caseless = new Map<string, Candidate[]>()
  for (const [providerID, provider] of Object.entries(registry)) {
    for (const [key, row] of Object.entries(provider.models)) {
      const candidate = { providerID, key, row }
      addTo(exact, key, candidate)
      addTo(caseless, key.toLowerCase(), candidate)
    }
  }
  // Exact candidates win outright when they yield a price; all-zero exact rows
  // must not shadow priced case-variant rows.
  return crossProviderVotes(registry, exact.get(modelID) ?? []) ?? crossProviderVotes(registry, caseless.get(modelID.toLowerCase()) ?? [])
}

export function match(
  registry: Registry,
  input: { readonly providerID: string; readonly modelID: string },
): Match | undefined {
  const provider = registry[input.providerID]
  const own = provider === undefined ? undefined : ownRow(provider.models, input.modelID)
  if (own !== undefined && hasPrice(own.row.cost)) return { cost: own.row.cost, source: "declared" }
  if (own !== undefined) {
    const canonical = walk(registry, own.row, `${input.providerID}/${own.key}`)
    if (canonical.priced !== undefined) return { cost: canonical.priced, source: "canonical" }
  }
  return crossProvider(registry, input.modelID)
}

const usd = (value: number | undefined) =>
  Money.USDPerMillionTokens.make(typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)

const toEntry = (cost: Cost, tier?: { readonly type: "context"; readonly size: number }): Model.Info["cost"][number] => ({
  ...(tier === undefined ? {} : { tier: { ...tier } }),
  input: usd(cost.input),
  output: usd(cost.output),
  cache: { read: usd(cost.cache_read), write: usd(cost.cache_write) },
})

/** Raw catalog cost → the registry's cost array, folding `context_over_200k` into a 200k context tier. */
export const toModelCost = (cost: Cost): Model.Info["cost"] => [
  toEntry(cost),
  ...(cost.tiers ?? []).map((tier) => toEntry(tier, tier.tier)),
  ...(cost.context_over_200k === undefined
    ? []
    : [toEntry(cost.context_over_200k, { type: "context" as const, size: 200_000 })]),
]

/**
 * The estimated cost for a row whose declared rates are all zero; undefined
 * when the row declares its own price (the caller keeps it) or nothing priced
 * matched. Like the V1 fork, a provider that never appears in the catalog
 * still resolves through same-name matching across it.
 */
export const estimate = (registry: Registry, providerID: string, modelID: string): Model.Info["cost"] | undefined => {
  const found = match(registry, { providerID, modelID })
  if (found === undefined || found.source === "declared") return undefined
  return toModelCost(found.cost)
}

/** True when the registry cost array carries any rate above zero. */
export const pricedModel = (cost: Model.Info["cost"]): boolean =>
  cost.some(
    (entry) => entry.input > 0 || entry.output > 0 || entry.cache.read > 0 || entry.cache.write > 0,
  )

const cloneModelCost = (cost: Model.Info["cost"]): Model.Info["cost"] =>
  cost.map((entry) => ({ ...entry, cache: { ...entry.cache }, ...(entry.tier === undefined ? {} : { tier: { ...entry.tier } }) }))

// Model name → prevailing price across the latest normalized catalog. Providers
// declared only in config (a token-plan block naming `qwen3.8-max`) create
// models the catalog never carried, so they cannot resolve through the cascade
// themselves; this table answers for them by name once every transform ran.
const named = new Map<string, Model.Info["cost"]>()

export const publishNamed = (costs: ReadonlyMap<string, readonly Model.Info["cost"][]>) => {
  named.clear()
  for (const [modelID, rows] of costs) {
    const sorted = [...rows].sort((a, b) => (a[0]?.input ?? 0) - (b[0]?.input ?? 0))
    const median = sorted[Math.floor((sorted.length - 1) / 2)]
    if (median !== undefined) named.set(modelID.toLowerCase(), cloneModelCost(median))
  }
}

export const namedCost = (modelID: string): Model.Info["cost"] | undefined => {
  const found = named.get(modelID.toLowerCase())
  return found === undefined ? undefined : cloneModelCost(found)
}
