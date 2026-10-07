export * as PricingBackfill from "./backfill"

import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { MessageTable, PartTable, SessionTable } from "../session/sql"
import type { SessionSchema } from "../session/schema"
import type { MessageID, PartID } from "../v1/session"
import { Pricing } from "../pricing"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type ResolveRates = (input: { providerID: string; modelID: string }) => Effect.Effect<Pricing.Match | undefined>

export type ModelSummary = {
  readonly providerID: string
  readonly modelID: string
  readonly match: Pricing.Match
  readonly messages: number
  readonly parts: number
  readonly sessions: number
  readonly delta: number
}

export type Summary = {
  readonly models: ReadonlyArray<ModelSummary>
  readonly unpriced: ReadonlyArray<{ readonly providerID: string; readonly modelID: string }>
  readonly messages: number
  readonly parts: number
  readonly sessions: number
  readonly delta: number
  readonly failed: ReadonlyArray<string>
}

/**
 * Re-price historical usage. Per session, in one transaction:
 * - zero-cost step-finish parts with tokens are re-priced at the matched rates
 *   (nonzero recorded costs, e.g. Copilot nanoAiu, are preserved);
 * - a message's cost is written only when it records zero: it becomes the sum
 *   of its step-finish part costs, or for a legacy message without step-finish
 * parts a display-only recompute from its own tokens (the durable event log
 * keeps the original cost=0 payloads — accepted residual risk: the replay
 * paths at control-plane/workspace.ts syncHistory and the sync route can
 * materialize cost=0 projections on OTHER instances, while in-place
 * re-projection of committed events is rejected by EventV2). A nonzero
 * recorded message cost is the billed truth and is preserved outright;
 * - session.cost becomes the sum of its final message costs (the 2026-05-10
 *   migration semantics), which equals the step-part sum for consistent data
 *   (the projector invariant). tokens_* columns are never touched.
 *
 * Model rates are resolved once up front, outside the per-session
 * transactions; a resolver failure (a contract violation) marks the pair
 * unpriced and never aborts the run. A session whose transaction fails is
 * rolled back, logged, and reported in `failed` without aborting the rest.
 * Idempotent: a second run with the same rates is a no-op. Rows whose resolved
 * rates price to zero are left unchanged. Without `apply` nothing is written.
 */
export function run(input: { db: Database; resolve: ResolveRates; apply: boolean }): Effect.Effect<Summary> {
  return Effect.gen(function* () {
    const scan = yield* input.db.select({ data: MessageTable.data }).from(MessageTable).all().pipe(Effect.orDie)
    const pairs = new Map<string, { providerID: string; modelID: string }>()
    for (const row of scan) {
      const info = assistantUsage(row.data)
      if (!info) continue
      pairs.set(modelKey(info.providerID, info.modelID), { providerID: info.providerID, modelID: info.modelID })
    }
    const prices = new Map<string, Pricing.Match | undefined>()
    for (const [key, pair] of pairs) {
      const exit = yield* Effect.exit(input.resolve(pair))
      prices.set(key, Exit.isSuccess(exit) ? exit.value : undefined)
    }
    const sessions = yield* input.db
      .select({ id: SessionTable.id, cost: SessionTable.cost })
      .from(SessionTable)
      .all()
      .pipe(Effect.orDie)
    const totals = new Map<string, MutableModelSummary>()
    const unpriced = new Set<string>()
    const failed: string[] = []
    let messages = 0
    let parts = 0
    let sessionChanges = 0
    let delta = 0
    for (const session of sessions) {
      const exit = yield* Effect.exit(input.db.transaction((tx) => processSession(tx, session, prices, input.apply)))
      if (Exit.isFailure(exit)) {
        failed.push(session.id)
        yield* Effect.logError("Usage backfill failed for session", { sessionID: session.id, cause: exit.cause })
        continue
      }
      const result = exit.value
      messages += result.messages
      parts += result.parts
      sessionChanges += result.sessions
      delta += result.delta
      for (const [key, summary] of result.models) {
        const existing = totals.get(key)
        if (!existing) {
          totals.set(key, summary)
          continue
        }
        existing.messages += summary.messages
        existing.parts += summary.parts
        existing.delta += summary.delta
        for (const sessionID of summary.sessions) existing.sessions.add(sessionID)
      }
      for (const key of result.unpriced) unpriced.add(key)
    }
    return {
      models: [...totals.entries()]
        .map(([key, summary]) => ({
          providerID: key.split("/")[0],
          modelID: key.slice(key.indexOf("/") + 1),
          match: summary.match,
          messages: summary.messages,
          parts: summary.parts,
          sessions: summary.sessions.size,
          delta: summary.delta,
        }))
        .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID)),
      unpriced: [...unpriced].sort().map((key) => ({
        providerID: key.split("/")[0],
        modelID: key.slice(key.indexOf("/") + 1),
      })),
      messages,
      parts,
      sessions: sessionChanges,
      delta,
      failed,
    }
  })
}

type MutableModelSummary = {
  match: Pricing.Match
  messages: number
  parts: number
  sessions: Set<string>
  delta: number
}

type SessionResult = {
  messages: number
  parts: number
  sessions: number
  delta: number
  models: Map<string, MutableModelSummary>
  unpriced: Set<string>
}

// SQL failures propagate to the caller, which rolls the transaction back and
// reports the session in `failed`.
function processSession(
  tx: Transaction,
  session: { id: SessionSchema.ID; cost: number },
  prices: Map<string, Pricing.Match | undefined>,
  apply: boolean,
): Effect.Effect<SessionResult, unknown> {
  return Effect.gen(function* () {
    const messageRows = yield* tx
      .select({ id: MessageTable.id, data: MessageTable.data })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, session.id))
      .all()
    const partRows = yield* tx
      .select({ id: PartTable.id, messageID: PartTable.message_id, data: PartTable.data })
      .from(PartTable)
      .where(eq(PartTable.session_id, session.id))
      .orderBy(PartTable.id)
      .all()
    const owners = new Map(messageRows.map((row) => [row.id, assistantUsage(row.data)]))
    const models = new Map<string, MutableModelSummary>()
    const unpriced = new Set<string>()
    const partUpdates = new Map<PartID, Record<string, unknown>>()
    const partSums = new Map<MessageID, number>()
    let partChanges = 0
    let delta = 0
    for (const part of partRows) {
      const step = stepFinishUsage(part.data)
      if (!step) continue
      const sum = partSums.get(part.messageID) ?? 0
      if (step.cost !== 0) {
        partSums.set(part.messageID, sum + step.cost)
        continue
      }
      if (!hasTokens(step.tokens)) {
        partSums.set(part.messageID, sum)
        continue
      }
      const owner = owners.get(part.messageID)
      if (!owner) {
        partSums.set(part.messageID, sum)
        continue
      }
      const key = modelKey(owner.providerID, owner.modelID)
      const match = prices.get(key)
      if (!match) {
        unpriced.add(key)
        partSums.set(part.messageID, sum)
        continue
      }
      const cost = Pricing.costOf(Pricing.rates(match.cost), step.tokens, contextTokens(step.tokens))
      partSums.set(part.messageID, sum + cost)
      if (cost === 0) continue
      partChanges++
      delta += cost
      partUpdates.set(part.id, withCost(part.data, cost))
      const tracked = trackModel(models, key, match, session.id)
      tracked.parts++
      tracked.delta += cost
    }
    let messageChanges = 0
    const messageUpdates = new Map<MessageID, Record<string, unknown>>()
    let sessionCost = 0
    for (const message of messageRows) {
      const info = assistantUsage(message.data)
      if (!info) continue
      const key = modelKey(info.providerID, info.modelID)
      // A nonzero recorded message cost is the billed truth (e.g. nanoAiu) and
      // survives re-priced parts underneath it; session.cost sums the final
      // message costs exactly like the 2026-05-10 migration.
      if (info.cost !== 0) {
        sessionCost += info.cost
        continue
      }
      const sum = partSums.get(message.id)
      if (sum !== undefined) {
        sessionCost += sum
        if (sum === 0) continue
        messageChanges++
        messageUpdates.set(message.id, withCost(message.data, sum))
        // Sum repair does not need prices and no new spend appears (the parts
        // delta already counted); only attribute the row when a match exists.
        const match = prices.get(key)
        if (match) trackModel(models, key, match, session.id).messages++
        continue
      }
      if (!info.tokens || !hasTokens(info.tokens)) continue
      const match = prices.get(key)
      if (!match) {
        unpriced.add(key)
        continue
      }
      const cost = Pricing.costOf(Pricing.rates(match.cost), info.tokens, contextTokens(info.tokens))
      sessionCost += cost
      if (cost === 0) continue
      messageChanges++
      delta += cost
      messageUpdates.set(message.id, withCost(message.data, cost))
      const tracked = trackModel(models, key, match, session.id)
      tracked.messages++
      tracked.delta += cost
    }
    const sessionChanged = sessionCost !== session.cost
    if (apply) {
      for (const [id, data] of partUpdates)
        yield* tx.update(PartTable).set({ data: data as typeof PartTable.$inferInsert.data }).where(eq(PartTable.id, id))
      for (const [id, data] of messageUpdates)
        yield* tx
          .update(MessageTable)
          .set({ data: data as typeof MessageTable.$inferInsert.data })
          .where(eq(MessageTable.id, id))
      if (sessionChanged)
        yield* tx.update(SessionTable).set({ cost: sessionCost }).where(eq(SessionTable.id, session.id))
    }
    return { messages: messageChanges, parts: partChanges, sessions: sessionChanged ? 1 : 0, delta, models, unpriced }
  })
}

function trackModel(
  models: Map<string, MutableModelSummary>,
  key: string,
  match: Pricing.Match,
  sessionID: string,
): MutableModelSummary {
  const existing = models.get(key)
  if (existing) {
    existing.sessions.add(sessionID)
    return existing
  }
  const created: MutableModelSummary = { match, messages: 0, parts: 0, sessions: new Set([sessionID]), delta: 0 }
  models.set(key, created)
  return created
}

const numberOr = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

function readTokens(value: unknown): Pricing.Tokens | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  // A missing cache object is a zero cache, not an invalid payload: providers
  // that never cached emit { input, output, reasoning } without `cache`.
  const cache = record.cache
  const caches = typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {}
  return {
    input: numberOr(record.input),
    output: numberOr(record.output),
    reasoning: numberOr(record.reasoning),
    cache: { read: numberOr(caches.read), write: numberOr(caches.write) },
  }
}

function hasTokens(value: Pricing.Tokens) {
  return value.input > 0 || value.output > 0 || value.reasoning > 0 || value.cache.read > 0 || value.cache.write > 0
}

function contextTokens(value: Pricing.Tokens) {
  return value.input + value.cache.read + value.cache.write
}

function stepFinishUsage(data: unknown): { cost: number; tokens: Pricing.Tokens } | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const value = data as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  const tokens = readTokens(value.tokens)
  if (!tokens) return undefined
  return { cost: numberOr(value.cost), tokens }
}

function assistantUsage(data: unknown) {
  if (typeof data !== "object" || data === null) return undefined
  const value = data as Record<string, unknown>
  if (value.role !== "assistant") return undefined
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return undefined
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    cost: numberOr(value.cost),
    tokens: readTokens(value.tokens),
  }
}

function withCost(data: unknown, cost: number) {
  return { ...(data as Record<string, unknown>), cost }
}

function modelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}
