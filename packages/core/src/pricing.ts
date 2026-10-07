export * as Pricing from "./pricing"

import { Clock, Context, Duration, Effect, Layer, Ref, Stream } from "effect"
import { Decimal } from "decimal.js"
import { ModelsDev } from "./models-dev"
import { EventV2 } from "./event"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

export type RegistryCost = NonNullable<ModelsDev.Model["cost"]>

export type Source = "declared" | "canonical" | "cross-provider"

export type Match = {
  readonly cost: RegistryCost
  readonly source: Source
}

export type Rates = {
  readonly input: number
  readonly output: number
  // Absent cache rates stay absent (no invented zeros) so registryCost can
  // round-trip models.dev cost rows that omit the optional cache fields.
  readonly cache: { readonly read?: number; readonly write?: number }
  readonly tiers?: ReadonlyArray<{
    readonly input: number
    readonly output: number
    readonly cache: { readonly read?: number; readonly write?: number }
    readonly tier: { readonly type: "context"; readonly size: number }
  }>
  readonly experimentalOver200K?: {
    readonly input: number
    readonly output: number
    readonly cache: { readonly read?: number; readonly write?: number }
  }
}

export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
  readonly total?: number
}

export type ResolveInput = { readonly providerID: string; readonly modelID: string }

/**
 * Pure price matching for one provider/model pair. Never invents prices: an
 * explicit zero without any nonzero match stays unpriced (undefined).
 *
 * Cascade: declared cost, then the `canonical_model_id` chain, then votes from
 * same-named models across providers (majority canonical target, median
 * fallback).
 */
export function match(models: Record<string, ModelsDev.Provider>, input: ResolveInput): Match | undefined {
  const provider = models[input.providerID]
  const own = provider ? ownRow(provider, input.modelID) : undefined
  if (own && nonzeroCost(own.row.cost)) return { cost: own.row.cost, source: "declared" }
  if (own) {
    const canonical = walkCanonical(models, own.row, `${input.providerID}/${own.key}`)
    if (canonical.priced) return { cost: canonical.priced.cost, source: "canonical" }
  }
  return crossProvider(models, input.modelID)
}

/**
 * Exact Session.getUsage cost math: tiered rates by context size (largest
 * matching `context` tier wins, else `experimentalOver200K` above 200k, else
 * base rates), reasoning billed at the output rate, USD per 1M tokens.
 */
export function costOf(rates: Rates | undefined, value: Tokens, contextTokens: number): number {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0)
  const safe = (value: number) => Math.max(0, finite(value))
  const costInfo =
    rates?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (rates?.experimentalOver200K && contextTokens > 200_000 ? rates.experimentalOver200K : rates)
  return safe(
    new Decimal(0)
      .add(new Decimal(safe(value.input)).mul(finite(costInfo?.input ?? 0)).div(1_000_000))
      .add(new Decimal(safe(value.output)).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
      .add(new Decimal(safe(value.cache.read)).mul(finite(costInfo?.cache?.read ?? 0)).div(1_000_000))
      .add(new Decimal(safe(value.cache.write)).mul(finite(costInfo?.cache?.write ?? 0)).div(1_000_000))
      .add(new Decimal(safe(value.reasoning)).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
      .toNumber(),
  )
}

/** models.dev snake_case cost → ProviderCost-style rates. */
export function rates(cost: ModelsDev.Model["cost"] | undefined): Rates {
  const tierRates = (item: { input: number; output: number; cache_read?: number; cache_write?: number }) => ({
    input: item.input,
    output: item.output,
    cache: cacheRates(item.cache_read, item.cache_write),
  })
  const tiers = (cost?.tiers ?? []).map((item) => ({ ...tierRates(item), tier: item.tier }))
  const over = cost?.context_over_200k
  // Fold `context_over_200k` into a 200k context tier (append after existing
  // tiers), consistent with the plugin's registry projection: the folded tier
  // competes by size with the other tiers instead of sitting in a separate
  // `experimentalOver200K` branch any sub-200k tier could shadow.
  const folded = over ? [...tiers, { ...tierRates(over), tier: { type: "context" as const, size: 200_000 } }] : tiers
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cache: cacheRates(cost?.cache_read, cost?.cache_write),
    ...(folded.length > 0 ? { tiers: folded } : {}),
  }
}

/** ProviderCost-style rates → models.dev snake_case cost. */
export function registryCost(value: Rates): RegistryCost {
  return {
    input: value.input,
    output: value.output,
    ...cacheFields(value.cache),
    ...(value.tiers
      ? {
          tiers: value.tiers.map((item) => ({
            input: item.input,
            output: item.output,
            ...cacheFields(item.cache),
            tier: item.tier,
          })),
        }
      : {}),
    ...(value.experimentalOver200K
      ? {
          context_over_200k: {
            input: value.experimentalOver200K.input,
            output: value.experimentalOver200K.output,
            ...cacheFields(value.experimentalOver200K.cache),
          },
        }
      : {}),
  }
}

const cacheRates = (read: number | undefined, write: number | undefined): Rates["cache"] => ({
  ...(read === undefined ? {} : { read }),
  ...(write === undefined ? {} : { write }),
})

const cacheFields = (cache: Rates["cache"]) => ({
  ...(cache.read === undefined ? {} : { cache_read: cache.read }),
  ...(cache.write === undefined ? {} : { cache_write: cache.write }),
})

/** True when every rate is zero — the catalog carries no price for the model. */
export function isZeroRates(value: Rates): boolean {
  const entryZero = (entry: { input: number; output: number; cache: Rates["cache"] }) =>
    entry.input === 0 && entry.output === 0 && (entry.cache.read ?? 0) === 0 && (entry.cache.write ?? 0) === 0
  return (
    entryZero(value) &&
    (value.tiers ?? []).every(entryZero) &&
    (value.experimentalOver200K === undefined || entryZero(value.experimentalOver200K))
  )
}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Match | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Pricing") {}

// Lazy web matching ("auto price match"): offline match first; only when that
// finds no nonzero price, refresh the registry and re-match. Fetches are
// throttled per process (first fetch immediately, retry after 5 minutes on
// failure, suppress for 24 hours after success) and never at startup — the
// fork's no-implicit-fetch policy stays intact. The flag
// OPENCODE_DISABLE_MODELS_FETCH suppresses fetches entirely.
const SUCCESS_TTL = Duration.hours(24)
const ATTEMPT_TTL = Duration.minutes(5)
// Unpriced memo entries expire so a later registry refresh is still noticed;
// priced entries live until ModelsDev.Event.Refreshed clears the memo.
const NEGATIVE_TTL = Duration.minutes(5)

type Memo = Readonly<{ value: Match | undefined; at: number }>

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const memo = yield* Ref.make(new Map<string, Memo>())
    const lastAttempt = yield* Ref.make<number | undefined>(undefined)
    const lastSuccess = yield* Ref.make<number | undefined>(undefined)
    yield* events
      .subscribe(ModelsDev.Event.Refreshed)
      .pipe(
        Stream.runForEach(() => Ref.set(memo, new Map())),
        Effect.forkScoped({ startImmediately: true }),
      )
    const resolve = Effect.fn("Pricing.resolve")(function* (input: ResolveInput) {
      const key = `${input.providerID}\u0000${input.modelID}`
      const now = yield* Clock.currentTimeMillis
      const cached = (yield* Ref.get(memo)).get(key)
      if (cached && (cached.value !== undefined || now - cached.at < Duration.toMillis(NEGATIVE_TTL))) return cached.value
      const put = (value: Match | undefined) =>
        Ref.update(memo, (map) => map.set(key, { value, at: now })).pipe(Effect.as(value))
      const offline = match(yield* modelsDev.get(), input)
      if (offline) return yield* put(offline)
      // Fetch only when still unpriced and the throttle allows: no successful
      // refresh in 24h and no attempt in the last 5 minutes.
      const success = yield* Ref.get(lastSuccess)
      const attempt = yield* Ref.get(lastAttempt)
      const allowed =
        !Flag.OPENCODE_DISABLE_MODELS_FETCH &&
        (success === undefined || now - success >= Duration.toMillis(SUCCESS_TTL)) &&
        (attempt === undefined || now - attempt >= Duration.toMillis(ATTEMPT_TTL))
      if (allowed) {
        yield* Ref.set(lastAttempt, now)
        // refresh reports whether registry data is fresh afterwards (already
        // fresh or fetched); only that counts as success for the 24h window.
        if (yield* modelsDev.refresh(false)) yield* Ref.set(lastSuccess, now)
      }
      return yield* put(match(yield* modelsDev.get(), input))
    })
    return Service.of({ resolve })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [ModelsDev.node, EventV2.node] })

function nonzeroCost(cost: ModelsDev.Model["cost"]): cost is RegistryCost {
  if (!cost) return false
  if (cost.input > 0 || cost.output > 0) return true
  if ((cost.cache_read ?? 0) > 0 || (cost.cache_write ?? 0) > 0) return true
  if (cost.tiers?.some((tier) => tier.input > 0 || tier.output > 0 || (tier.cache_read ?? 0) > 0 || (tier.cache_write ?? 0) > 0))
    return true
  const over = cost.context_over_200k
  return over !== undefined && (over.input > 0 || over.output > 0 || (over.cache_read ?? 0) > 0 || (over.cache_write ?? 0) > 0)
}

type Row = { key: string; row: ModelsDev.Model }

function lookup(models: Record<string, ModelsDev.Provider>, key: string): Row | undefined {
  const split = key.indexOf("/")
  if (split < 0) return undefined
  const row = models[key.slice(0, split)]?.models[key.slice(split + 1)]
  return row ? { key, row } : undefined
}

/**
 * Exact own-row lookup first; on a miss accept a model key equal under
 * toLowerCase, but only when exactly one such key exists — providers with
 * case-collision siblings must not be guessed between.
 */
function ownRow(provider: ModelsDev.Provider, modelID: string): Row | undefined {
  const exact = provider.models[modelID]
  if (exact) return { key: modelID, row: exact }
  const variants = Object.keys(provider.models).filter((key) => key.toLowerCase() === modelID.toLowerCase())
  if (variants.length !== 1) return undefined
  const row = provider.models[variants[0]]
  return row ? { key: variants[0], row } : undefined
}

/**
 * Follow `canonical_model_id` at most 3 hops with a cycle guard (self-canonical
 * rows are normal terminals). Returns the chain terminal key (grouping id for
 * cross-provider votes) and the first nonzero row found along the chain.
 */
function walkCanonical(models: Record<string, ModelsDev.Provider>, row: ModelsDev.Model, ownKey: string) {
  const visited = new Set([ownKey])
  let terminal = ownKey
  let priced: { key: string; cost: RegistryCost } | undefined
  let key = row.canonical_model_id
  for (let hop = 0; hop < 3 && key !== undefined && !visited.has(key); hop++) {
    const found = lookup(models, key)
    if (!found) break
    visited.add(key)
    terminal = key
    if (priced === undefined && nonzeroCost(found.row.cost)) priced = { key, cost: found.row.cost }
    key = found.row.canonical_model_id
  }
  return { terminal, priced }
}

function crossProvider(models: Record<string, ModelsDev.Provider>, modelID: string): Match | undefined {
  const entries = Object.entries(models).flatMap(([providerID, provider]) =>
    Object.entries(provider.models).map(([key, row]) => ({ providerID, key, row })),
  )
  // Exact candidates win outright when they yield a price. All-zero exact rows
  // must not shadow priced case-variant rows, so on nothing the pipeline
  // re-runs on the union with the case-insensitive matches (the real registry
  // has 147 case-collision groups — merging variants into a priced exact set
  // would change results).
  return (
    crossProviderVotes(models, entries.filter((entry) => entry.key === modelID)) ??
    crossProviderVotes(
      models,
      entries.filter((entry) => entry.key.toLowerCase() === modelID.toLowerCase()),
    )
  )
}

type Candidate = { providerID: string; key: string; row: ModelsDev.Model }

function crossProviderVotes(models: Record<string, ModelsDev.Provider>, candidates: readonly Candidate[]): Match | undefined {
  const votes = new Map<string, Set<string>>()
  const effective: RegistryCost[] = []
  for (const candidate of candidates) {
    const walk = walkCanonical(models, candidate.row, `${candidate.providerID}/${candidate.key}`)
    const cost = nonzeroCost(candidate.row.cost) ? candidate.row.cost : walk.priced?.cost
    if (!cost) continue
    effective.push(cost)
    const voters = votes.get(walk.terminal) ?? new Set<string>()
    voters.add(candidate.providerID)
    votes.set(walk.terminal, voters)
  }
  const ranked = [...votes.entries()]
    .map(([id, voters]) => ({ id, count: voters.size }))
    .sort((a, b) => b.count - a.count)
  const winner = ranked[0] && ranked[0].count > (ranked[1]?.count ?? 0) ? ranked[0] : undefined
  if (winner) {
    const row = lookup(models, winner.id)
    if (row && nonzeroCost(row.row.cost)) return { cost: row.row.cost, source: "cross-provider" }
  }
  if (effective.length === 0) return undefined
  const sorted = [...effective].sort((a, b) => a.input - b.input)
  // Median by input rate over the observations themselves (one per candidate
  // provider row, duplicates counted); on an even count take the lower middle
  // so the result is always an observed cost object rather than a synthesized
  // blend.
  return { cost: sorted[Math.floor((sorted.length - 1) / 2)], source: "cross-provider" }
}
