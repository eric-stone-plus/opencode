import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Pricing } from "@opencode-ai/core/pricing"
import { PricingBackfill } from "@opencode-ai/core/pricing/backfill"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const createTables = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, cost real NOT NULL DEFAULT 0, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0)`)
    yield* db.run(
      sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0)`,
    )
    yield* db.run(
      sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0)`,
    )
  })

const tokens = (input: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}) => ({ total: input.input + input.output + input.cache.read + input.cache.write, ...input })

const t1 = tokens({ input: 1000, output: 500, reasoning: 200, cache: { read: 3000, write: 400 } })
const t2 = tokens({ input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } })

const assistantData = (input: {
  providerID: string
  modelID: string
  cost: number
  tokens: ReturnType<typeof tokens>
}) => ({
  role: "assistant",
  time: { created: 1 },
  parentID: "parent",
  modelID: input.modelID,
  providerID: input.providerID,
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: input.cost,
  tokens: input.tokens,
})

const stepFinishData = (input: { cost: number; tokens: ReturnType<typeof tokens> }) => ({
  type: "step-finish",
  reason: "stop",
  cost: input.cost,
  tokens: input.tokens,
})

const demoMatch: Pricing.Match = {
  cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
  source: "cross-provider",
}

const tieredMatch: Pricing.Match = {
  cost: {
    input: 2,
    output: 6,
    tiers: [{ input: 0.5, output: 1, cache_read: 0.05, cache_write: 0.1, tier: { type: "context", size: 128_000 } }],
  },
  source: "canonical",
}

const resolve = (input: { providerID: string; modelID: string }) =>
  Effect.succeed(input.modelID === "demo-model" ? demoMatch : input.modelID === "demo-tiered" ? tieredMatch : undefined)

// Costs below are hand-expanded from demoMatch rates: (input*2 + output*6 +
// cache.read*0.25 + cache.write*2.5 + reasoning*6) / 1e6.
const expectedT1 = (1000 * 2 + 500 * 6 + 3000 * 0.25 + 400 * 2.5 + 200 * 6) / 1_000_000
const expectedT2 = (100 * 2 + 50 * 6) / 1_000_000

const seedUsageHistory = Effect.gen(function* () {
  const db = yield* makeDb
  yield* createTables(db)
  yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0.42})`)
  yield* db.run(
    sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
      assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0, tokens: t1 }),
    )})`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
      stepFinishData({ cost: 0, tokens: t1 }),
    )})`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p3"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
      stepFinishData({ cost: 0, tokens: t2 }),
    )})`,
  )
  yield* db.run(
    sql`INSERT INTO message (id, session_id, data) VALUES (${"m2"}, ${"s1"}, ${JSON.stringify(
      assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0.42, tokens: t2 }),
    )})`,
  )
  // A preserved nonzero step cost, e.g. Copilot nanoAiu billing.
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p2"}, ${"m2"}, ${"s1"}, ${JSON.stringify(
      stepFinishData({ cost: 0.42, tokens: t2 }),
    )})`,
  )
  return db
})

const readCosts = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    return {
      parts: yield* db.all<{ id: string; cost: number }>(
        sql`SELECT id, json_extract(data, '$.cost') AS cost FROM part ORDER BY id`,
      ),
      messages: yield* db.all<{ id: string; cost: number }>(
        sql`SELECT id, json_extract(data, '$.cost') AS cost FROM message ORDER BY id`,
      ),
      sessions: yield* db.all<{ id: string; cost: number }>(sql`SELECT id, cost FROM session ORDER BY id`),
    }
  })

describe("PricingBackfill", () => {
  test("re-prices zero-cost history and keeps message, part, and session sums equal", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* seedUsageHistory
        const summary = yield* PricingBackfill.run({ db, resolve, apply: true })

        expect(yield* readCosts(db)).toEqual({
          parts: [
            { id: "p1", cost: expectedT1 },
            { id: "p2", cost: 0.42 },
            { id: "p3", cost: expectedT2 },
          ],
          messages: [
            { id: "m1", cost: expectedT1 + expectedT2 },
            // Nonzero recorded message cost survives re-priced parts under it.
            { id: "m2", cost: 0.42 },
          ],
          sessions: [{ id: "s1", cost: expectedT1 + expectedT2 + 0.42 }],
        })

        // Projector invariant for consistent data: message sum == parts sum ==
        // session.cost (session.cost is the migration sum of final message
        // costs).
        const sums = yield* readCosts(db)
        const messageSum = sums.messages.reduce((total, row) => total + row.cost, 0)
        const partSum = sums.parts.reduce((total, row) => total + row.cost, 0)
        expect(messageSum).toBeCloseTo(partSum, 12)
        expect(sums.sessions[0].cost).toBeCloseTo(messageSum, 12)

        expect(summary.parts).toBe(2)
        expect(summary.messages).toBe(1)
        expect(summary.sessions).toBe(1)
        expect(summary.delta).toBeCloseTo(expectedT1 + expectedT2, 12)
        expect(summary.models).toHaveLength(1)
        expect(summary.models[0].match).toEqual(demoMatch)
        expect(summary.models[0].parts).toBe(2)
        expect(summary.models[0].messages).toBe(1)
        expect(summary.models[0].sessions).toBe(1)
        expect(summary.models[0].delta).toBeCloseTo(expectedT1 + expectedT2, 12)
        expect(summary.unpriced).toEqual([])
        expect(summary.failed).toEqual([])
      }),
    )
  })

  test("dry run reports the same plan without touching rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* seedUsageHistory
        const before = yield* readCosts(db)
        const summary = yield* PricingBackfill.run({ db, resolve, apply: false })
        expect(yield* readCosts(db)).toEqual(before)
        expect(summary.parts).toBe(2)
        expect(summary.messages).toBe(1)
        expect(summary.sessions).toBe(1)
      }),
    )
  })

  test("preserves nonzero recorded costs", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* seedUsageHistory
        yield* PricingBackfill.run({ db, resolve, apply: true })
        const costs = yield* readCosts(db)
        expect(costs.parts.find((row) => row.id === "p2")?.cost).toBe(0.42)
        expect(costs.messages.find((row) => row.id === "m2")?.cost).toBe(0.42)
        expect(costs.sessions[0].cost).toBeCloseTo(expectedT1 + expectedT2 + 0.42, 12)
      }),
    )
  })

  test("is idempotent when run twice with the same rates", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* seedUsageHistory
        yield* PricingBackfill.run({ db, resolve, apply: true })
        const after = yield* readCosts(db)
        const second = yield* PricingBackfill.run({ db, resolve, apply: true })
        expect(yield* readCosts(db)).toEqual(after)
        expect(second.parts).toBe(0)
        expect(second.messages).toBe(0)
        expect(second.sessions).toBe(0)
        expect(second.delta).toBe(0)
      }),
    )
  })

  test("leaves unpriced models at zero", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-unknown", cost: 0, tokens: t1 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
            stepFinishData({ cost: 0, tokens: t1 }),
          )})`,
        )
        const summary = yield* PricingBackfill.run({ db, resolve, apply: true })
        expect(yield* readCosts(db)).toEqual({
          parts: [{ id: "p1", cost: 0 }],
          messages: [{ id: "m1", cost: 0 }],
          sessions: [{ id: "s1", cost: 0 }],
        })
        expect(summary.parts).toBe(0)
        expect(summary.delta).toBe(0)
        expect(summary.unpriced).toEqual([{ providerID: "demo-pricing", modelID: "demo-unknown" }])
      }),
    )
  })

  test("tiered rates select the context tier from reconstructed context tokens", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        // contextTokens = input + cache.read + cache.write = 200_000 > tier size 128_000.
        const t3 = tokens({ input: 100_000, output: 0, reasoning: 0, cache: { read: 90_000, write: 10_000 } })
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-tiered", cost: 0, tokens: t3 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
            stepFinishData({ cost: 0, tokens: t3 }),
          )})`,
        )
        yield* PricingBackfill.run({ db, resolve, apply: true })
        const expectedTiered = (100_000 * 0.5 + 90_000 * 0.05 + 10_000 * 0.1) / 1_000_000
        const costs = yield* readCosts(db)
        expect(costs.parts[0].cost).toBeCloseTo(expectedTiered, 12)
        expect(costs.messages[0].cost).toBeCloseTo(expectedTiered, 12)
        expect(costs.sessions[0].cost).toBeCloseTo(expectedTiered, 12)
        // Base rates would have produced 0.2; the tier rates prove tier selection.
        expect(costs.parts[0].cost).not.toBeCloseTo((100_000 * 2) / 1_000_000, 6)
      }),
    )
  })

  test("legacy messages without step-finish parts are re-priced from message tokens", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0, tokens: t1 }),
          )})`,
        )
        const summary = yield* PricingBackfill.run({ db, resolve, apply: true })
        const costs = yield* readCosts(db)
        expect(costs.messages[0].cost).toBeCloseTo(expectedT1, 12)
        // Session cost is the sum of final message costs, legacy recompute
        // included (2026-05-10 migration semantics).
        expect(costs.sessions[0].cost).toBeCloseTo(expectedT1, 12)
        expect(summary.messages).toBe(1)
        expect(summary.parts).toBe(0)
      }),
    )
  })

  test("preserves a nonzero recorded message cost even when its parts re-price", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0.42})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0.42, tokens: t2 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
            stepFinishData({ cost: 0, tokens: t2 }),
          )})`,
        )
        yield* PricingBackfill.run({ db, resolve, apply: true })
        const costs = yield* readCosts(db)
        expect(costs.parts[0].cost).toBeCloseTo(expectedT2, 12)
        // The billed message cost is preserved; the part underneath is still
        // re-priced at its own zero. Session cost sums final message costs, so
        // the part sum may exceed it for this inconsistent mixed case.
        expect(costs.messages[0].cost).toBe(0.42)
        expect(costs.sessions[0].cost).toBe(0.42)
      }),
    )
  })

  test("prices token payloads that omit the cache object", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0, tokens: t2 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify({
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: { input: 100, output: 50, reasoning: 0 },
          })})`,
        )
        yield* PricingBackfill.run({ db, resolve, apply: true })
        const costs = yield* readCosts(db)
        expect(costs.parts[0].cost).toBeCloseTo(expectedT2, 12)
        expect(costs.messages[0].cost).toBeCloseTo(expectedT2, 12)
        expect(costs.sessions[0].cost).toBeCloseTo(expectedT2, 12)
      }),
    )
  })

  test("a throwing resolver is treated as unpriced and does not abort the run", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${"s1"}, ${0})`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m1"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0, tokens: t2 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p1"}, ${"m1"}, ${"s1"}, ${JSON.stringify(
            stepFinishData({ cost: 0, tokens: t2 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES (${"m2"}, ${"s1"}, ${JSON.stringify(
            assistantData({ providerID: "demo-pricing", modelID: "demo-boom", cost: 0, tokens: t2 }),
          )})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p2"}, ${"m2"}, ${"s1"}, ${JSON.stringify(
            stepFinishData({ cost: 0, tokens: t2 }),
          )})`,
        )
        const throwing = (input: { providerID: string; modelID: string }) =>
          input.modelID === "demo-boom" ? Effect.sync(() => { throw new Error("resolver contract violation") }) : resolve(input)
        const summary = yield* PricingBackfill.run({ db, resolve: throwing, apply: true })
        const costs = yield* readCosts(db)
        expect(costs.parts.find((row) => row.id === "p1")?.cost).toBeCloseTo(expectedT2, 12)
        expect(costs.messages.find((row) => row.id === "m1")?.cost).toBeCloseTo(expectedT2, 12)
        expect(costs.parts.find((row) => row.id === "p2")?.cost).toBe(0)
        expect(costs.messages.find((row) => row.id === "m2")?.cost).toBe(0)
        expect(summary.unpriced).toEqual([{ providerID: "demo-pricing", modelID: "demo-boom" }])
        expect(summary.failed).toEqual([])
      }),
    )
  })

  test("a failed session is reported and does not abort the others", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        for (const id of ["s1", "s2"]) {
          yield* db.run(sql`INSERT INTO session (id, cost) VALUES (${id}, ${0})`)
          yield* db.run(
            sql`INSERT INTO message (id, session_id, data) VALUES (${"m-" + id}, ${id}, ${JSON.stringify(
              assistantData({ providerID: "demo-pricing", modelID: "demo-model", cost: 0, tokens: t2 }),
            )})`,
          )
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, data) VALUES (${"p-" + id}, ${"m-" + id}, ${id}, ${JSON.stringify(
              stepFinishData({ cost: 0, tokens: t2 }),
            )})`,
          )
        }
        yield* db.run(sql`CREATE TRIGGER poison BEFORE UPDATE ON part WHEN NEW.session_id = 's2' BEGIN SELECT RAISE(ABORT, 'poison'); END`)
        const summary = yield* PricingBackfill.run({ db, resolve, apply: true })
        expect(summary.failed).toEqual(["s2"])
        const costs = yield* readCosts(db)
        expect(costs.sessions.find((row) => row.id === "s1")?.cost).toBeCloseTo(expectedT2, 12)
        expect(costs.sessions.find((row) => row.id === "s2")?.cost).toBe(0)
        // Re-run after the poison clears: the failed session is picked up and
        // the committed one is idempotent.
        yield* db.run(sql`DROP TRIGGER poison`)
        const second = yield* PricingBackfill.run({ db, resolve, apply: true })
        expect(second.failed).toEqual([])
        expect(second.sessions).toBe(1)
        expect((yield* readCosts(db)).sessions.find((row) => row.id === "s2")?.cost).toBeCloseTo(expectedT2, 12)
      }),
    )
  })
})
