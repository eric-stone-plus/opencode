import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { KV } from "@opencode/core/kv"
import { Bus } from "@opencode/core/bus"
import { WebSearch } from "@opencode/core/websearch"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"
import { TestWebSearch } from "./lib/websearch"

const it = testEffect(TestWebSearch.layer)
const firstSession = Session.ID.make("ses_search_first")
const secondSession = Session.ID.make("ses_search_second")

const register = (id: string) =>
  Effect.gen(function* () {
    const websearch = yield* WebSearch.Service
    const providerID = WebSearch.ID.make(id)
    const calls: WebSearch.ProviderInput[] = []
    const failure: { cause?: unknown } = {}
    const registration = yield* websearch.transform((editor) => {
      editor.add({
        id: providerID,
        name: id.toUpperCase(),
        execute: (input) =>
          Effect.gen(function* () {
            calls.push(input)
            if (failure.cause !== undefined) return yield* Effect.fail(failure.cause)
            return [
              {
                url: `https://${id}.example.com`,
                title: input.query,
                content: `${id}: ${input.query}`,
                time: {},
              },
            ]
          }),
      })
    })
    return { providerID, calls, failure, dispose: registration.dispose }
  })

describe("WebSearch", () => {
  it.effect("shares the normal and test interfaces without installing live providers", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const test = yield* TestWebSearch.Service

      expect(websearch).toBe(test)
      expect(yield* websearch.providers()).toEqual([])
      expect(test.queries).toEqual([])
      expect((yield* websearch.query({ query: "unconfigured" }).pipe(Effect.flip))._tag).toBe(
        "WebSearch.ProviderRequired",
      )
      yield* test.wait(1)
      expect(test.queries).toEqual([{ query: "unconfigured" }])
    }),
  )

  it.effect("executes an explicit provider without changing the default", () =>
    Effect.gen(function* () {
      yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      const test = yield* TestWebSearch.Service

      expect(yield* websearch.query({ query: "effect", providerID: downlink.providerID })).toEqual(
        new WebSearch.Response({
          providerID: downlink.providerID,
          results: [
            {
              url: "https://relay.example.com",
              title: "effect",
              content: "relay: effect",
              time: {},
            },
          ],
        }),
      )
      expect((yield* websearch.query({ query: "default" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
      expect(downlink.calls).toEqual([{ query: "effect" }])
      expect(test.queries).toEqual([{ query: "effect", providerID: downlink.providerID }, { query: "default" }])
    }),
  )

  it.effect("forwards optional search hints to the provider", () =>
    Effect.gen(function* () {
      const provider = yield* register("axis")
      const websearch = yield* WebSearch.Service

      yield* websearch.query(
        { query: "effect", providerID: provider.providerID },
        { oriQuestion: "what is effect", needContent: true },
      )

      expect(provider.calls).toEqual([
        { query: "effect", oriQuestion: "what is effect", needContent: true },
      ])
    }),
  )

  it.effect("requires a provider when no default is set", () =>
    Effect.gen(function* () {
      yield* register("axis")
      yield* register("relay")
      const websearch = yield* WebSearch.Service

      expect((yield* websearch.query({ query: "layers" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
    }),
  )

  it.effect("uses the default set by a transform", () =>
    Effect.gen(function* () {
      yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((editor) => editor.default.set(downlink.providerID))

      expect((yield* websearch.query({ query: "configured" })).providerID).toBe(downlink.providerID)
    }),
  )

  it.effect("reloads active transforms from their current source", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      const source = { providerID: net.providerID }
      yield* websearch.transform((editor) => editor.default.set(source.providerID))

      expect((yield* websearch.default())?.id).toBe(net.providerID)
      source.providerID = downlink.providerID
      yield* websearch.reload()
      expect((yield* websearch.default())?.id).toBe(downlink.providerID)
    }),
  )

  it.effect("persists the selected provider in KV", () =>
    Effect.gen(function* () {
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service

      yield* websearch.select(downlink.providerID)

      expect(yield* kv.get(WebSearch.ProviderKey)).toBe(downlink.providerID)
      expect((yield* websearch.query({ query: "remembered" })).providerID).toBe(downlink.providerID)
    }),
  )

  it.effect("keeps config transforms above the persisted selection", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.select(downlink.providerID)
      yield* websearch.transform((editor) => editor.default.set(net.providerID))

      expect((yield* websearch.query({ query: "configured" })).providerID).toBe(net.providerID)
    }),
  )

  it.effect("keeps the random provider across queries, default lookups, and reloads", () =>
    Effect.gen(function* () {
      yield* register("axis")
      yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((editor) => editor.default.set("random"))

      const first = yield* websearch.query({ query: "first" })
      expect(["axis", "relay"]).toContain(first.providerID)
      expect((yield* websearch.default())?.id).toBe(first.providerID)
      yield* websearch.reload()
      const results = yield* Effect.all(
        Array.from({ length: 10 }, () => websearch.query({ query: "next" })),
        { concurrency: "unbounded" },
      )
      expect(results.every((result) => result.providerID === first.providerID)).toBe(true)
    }),
  )

  it.effect("preserves persisted random selection and keeps its provider", () =>
    Effect.gen(function* () {
      yield* register("axis")
      yield* register("relay")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set(WebSearch.ProviderKey, "random")
      const first = yield* websearch.query({ query: "legacy" })
      expect((yield* websearch.query({ query: "sticky" })).providerID).toBe(first.providerID)
      yield* websearch.select("random")
      expect(yield* kv.get(WebSearch.ProviderKey)).toBe("random")
      expect((yield* websearch.query({ query: "canonical" })).providerID).toBe(first.providerID)
    }),
  )
  it.effect("fails over on rate limits with random and keeps the replacement after cooldown", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((editor) => editor.default.set("random"))
      const first = yield* websearch.query({ query: "first" })
      const limited = first.providerID === net.providerID ? net : downlink
      const replacement = first.providerID === net.providerID ? downlink : net
      limited.failure.cause = TestWebSearch.httpError()
      const progress: WebSearch.ID[] = []
      expect(
        (yield* websearch.query(
          { query: "retry" },
          {
            onProvider: (provider) =>
              Effect.sync(() => {
                progress.push(provider.id)
              }),
          },
        )).providerID,
      ).toBe(replacement.providerID)
      expect(progress).toEqual([limited.providerID, replacement.providerID])
      expect(limited.calls.at(-1)).toEqual({ query: "retry" })
      expect(replacement.calls).toEqual([{ query: "retry" }])

      limited.failure.cause = undefined
      yield* TestClock.adjust("59 seconds")
      expect((yield* websearch.query({ query: "cooling" })).providerID).toBe(replacement.providerID)
      expect(limited.calls).toHaveLength(2)
      yield* TestClock.adjust("1 second")
      expect((yield* websearch.query({ query: "still sticky" })).providerID).toBe(replacement.providerID)
      replacement.failure.cause = TestWebSearch.httpError()
      expect((yield* websearch.query({ query: "recovered" })).providerID).toBe(limited.providerID)
    }),
  )

  it.effect("reselects when a concurrent query cools down the provider while progress is pending", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      yield* websearch.query({ query: "seed" })
      const first = yield* websearch.default()
      if (!first) return yield* Effect.die("Expected an automatic provider")
      const limited = first.id === net.providerID ? net : downlink
      const replacement = first.id === net.providerID ? downlink : net
      const paused = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const progress: WebSearch.ID[] = []
      const pending = yield* websearch
        .query(
          { query: "pending" },
          {
            onProvider: (provider) =>
              Effect.gen(function* () {
                progress.push(provider.id)
                if (provider.id !== first.id) return
                yield* Deferred.succeed(paused, undefined)
                yield* Deferred.await(resume)
              }),
          },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(paused)
      limited.failure.cause = TestWebSearch.httpError()
      expect((yield* websearch.query({ query: "trigger" })).providerID).toBe(replacement.providerID)
      yield* Deferred.succeed(resume, undefined)
      expect((yield* Fiber.join(pending)).providerID).toBe(replacement.providerID)
      expect(progress).toEqual([limited.providerID, replacement.providerID])
      expect(limited.calls).toEqual([{ query: "seed" }, { query: "trigger" }])
      expect(replacement.calls).toEqual([{ query: "trigger" }, { query: "pending" }])
    }),
  )

  it.effect("fails promptly when all providers are cooling down without asking for a provider", () =>
    Effect.gen(function* () {
      const providers = [yield* register("axis"), yield* register("relay"), yield* register("vector")]
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      providers.forEach((provider) => {
        provider.failure.cause = TestWebSearch.httpError()
      })
      expect(yield* websearch.query({ query: "limited" }).pipe(Effect.flip)).toBeInstanceOf(WebSearch.RequestError)
      expect(providers.map((provider) => provider.calls.length)).toEqual([1, 1, 1])
      expect(yield* websearch.default()).toBeDefined()
      expect(yield* websearch.query({ query: "still limited" }).pipe(Effect.flip)).toBeInstanceOf(
        WebSearch.RequestError,
      )
      expect(providers.map((provider) => provider.calls.length)).toEqual([1, 1, 1])
    }),
  )

  it.effect("tries each provider only once per query even with a zero cooldown", () =>
    Effect.gen(function* () {
      const providers = [yield* register("axis"), yield* register("relay")]
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      providers.forEach((provider) => {
        provider.failure.cause = TestWebSearch.httpError(429, "0")
      })
      expect(yield* websearch.query({ query: "limited" }).pipe(Effect.flip)).toBeInstanceOf(WebSearch.RequestError)
      expect(providers.map((provider) => provider.calls.length)).toEqual([1, 1])
    }),
  )
  ;[
    { header: "120", millis: 120_000 },
    { header: "Thu, 01 Jan 1970 00:02:00 GMT", millis: 120_000 },
    { header: undefined, millis: 60_000 },
    { header: "invalid", millis: 60_000 },
    { header: "", millis: 60_000 },
    { header: "-1", millis: 60_000 },
  ].forEach(({ header, millis }) => {
    it.effect(`respects Retry-After ${JSON.stringify(header)} and recovers after cooldown`, () =>
      Effect.gen(function* () {
        const provider = yield* register("axis")
        const websearch = yield* WebSearch.Service
        yield* websearch.select("random")
        provider.failure.cause = TestWebSearch.httpError(429, header)
        expect(yield* websearch.query({ query: "limited" }).pipe(Effect.flip)).toBeInstanceOf(WebSearch.RequestError)
        provider.failure.cause = undefined
        yield* TestClock.adjust(millis - 1)
        expect(yield* websearch.query({ query: "early" }).pipe(Effect.flip)).toBeInstanceOf(WebSearch.RequestError)
        expect(provider.calls).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect((yield* websearch.query({ query: "recovered" })).providerID).toBe(provider.providerID)
        expect(provider.calls).toHaveLength(2)
      }),
    )
  })

  it.effect("does not rotate or cool down providers for other failures", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      const first = yield* websearch.query({ query: "first" })
      const provider = first.providerID === net.providerID ? net : downlink
      yield* Effect.forEach(
        [TestWebSearch.httpError(401), TestWebSearch.httpError(500), new Error("timeout")],
        (cause) =>
          Effect.gen(function* () {
            provider.failure.cause = cause
            expect(yield* websearch.query({ query: "failure" }).pipe(Effect.flip)).toMatchObject({
              providerID: first.providerID,
              cause,
            })
            expect((yield* websearch.default())?.id).toBe(first.providerID)
          }),
      )
      provider.failure.cause = undefined
      expect((yield* websearch.query({ query: "recovered" })).providerID).toBe(first.providerID)
      expect((first.providerID === net.providerID ? downlink : net).calls).toEqual([])
    }),
  )

  it.effect("does not fail over fixed or explicitly requested providers", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      net.failure.cause = TestWebSearch.httpError()
      yield* websearch.select(net.providerID)
      expect(yield* websearch.query({ query: "fixed" }).pipe(Effect.flip)).toMatchObject({ providerID: net.providerID })
      yield* websearch.select("random")
      expect(yield* websearch.query({ query: "explicit", providerID: net.providerID }).pipe(Effect.flip)).toMatchObject(
        {
          providerID: net.providerID,
        },
      )
      expect(net.calls).toHaveLength(2)
      expect(downlink.calls).toEqual([])
    }),
  )

  it.effect("reselects when the active provider is removed", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      expect((yield* websearch.query({ query: "first" })).providerID).toBe(net.providerID)
      const downlink = yield* register("relay")
      expect((yield* websearch.query({ query: "still sticky" })).providerID).toBe(net.providerID)
      yield* net.dispose
      expect((yield* websearch.query({ query: "removed" })).providerID).toBe(downlink.providerID)
    }),
  )

  it.effect("uses updated registrations for the sticky provider", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      expect((yield* websearch.query({ query: "original" })).results).toHaveLength(1)
      const updated = yield* websearch.transform((editor) =>
        editor.add({
          id: net.providerID,
          name: "Updated Net",
          execute: () => Effect.succeed([]),
        }),
      )
      expect(yield* websearch.default()).toEqual({ id: net.providerID, name: "Updated Net" })
      expect((yield* websearch.query({ query: "updated" })).results).toEqual([])
      yield* updated.dispose
      expect((yield* websearch.query({ query: "restored" })).results).toHaveLength(1)
      expect(net.calls).toEqual([{ query: "original" }, { query: "restored" }])
    }),
  )

  it.effect("keeps independent session affinities across concurrent initial and subsequent searches", () =>
    Effect.gen(function* () {
      yield* register("axis")
      yield* register("relay")
      yield* register("vector")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      const results = yield* Effect.forEach(
        [firstSession, secondSession],
        (sessionID) =>
          Effect.all(
            Array.from({ length: 8 }, () => websearch.query({ query: "relay" }, { sessionID })),
            {
              concurrency: "unbounded",
            },
          ),
        { concurrency: "unbounded" },
      )
      expect(results.map((group) => new Set(group.map((result) => result.providerID)).size)).toEqual([1, 1])
      expect((yield* websearch.query({ query: "later" }, { sessionID: firstSession })).providerID).toBe(
        results[0]?.[0]?.providerID,
      )
      expect((yield* websearch.query({ query: "later" }, { sessionID: secondSession })).providerID).toBe(
        results[1]?.[0]?.providerID,
      )
    }),
  )

  it.effect("does not overwrite peer or Location affinity when a session switches providers", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      yield* websearch.query({ query: "location" })
      yield* websearch.query({ query: "first" }, { sessionID: firstSession })
      yield* websearch.query({ query: "second" }, { sessionID: secondSession })
      const downlink = yield* register("relay")
      net.failure.cause = TestWebSearch.httpError()
      expect((yield* websearch.query({ query: "switch" }, { sessionID: firstSession })).providerID).toBe(
        downlink.providerID,
      )
      // Even while a provider is cooling down, inspection must not reroute any caller.
      expect((yield* websearch.default())?.id).toBe(net.providerID)
      net.failure.cause = undefined
      yield* TestClock.adjust("1 minute")
      expect((yield* websearch.query({ query: "peer" }, { sessionID: secondSession })).providerID).toBe(net.providerID)
      expect((yield* websearch.query({ query: "location" })).providerID).toBe(net.providerID)
      expect((yield* websearch.query({ query: "sticky replacement" }, { sessionID: firstSession })).providerID).toBe(
        downlink.providerID,
      )
    }),
  )

  it.effect("shares cooldowns without sending a peer back to the rate-limited provider", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.select("random")
      yield* websearch.query({ query: "first" }, { sessionID: firstSession })
      yield* websearch.query({ query: "second" }, { sessionID: secondSession })
      const downlink = yield* register("relay")
      net.failure.cause = TestWebSearch.httpError(429, "120")
      yield* websearch.query({ query: "switch" }, { sessionID: firstSession })
      expect((yield* websearch.query({ query: "peer" }, { sessionID: secondSession })).providerID).toBe(
        downlink.providerID,
      )
      expect(net.calls).toHaveLength(3)
      net.failure.cause = undefined
      yield* TestClock.adjust("2 minutes")
      expect((yield* websearch.query({ query: "sticky peer" }, { sessionID: secondSession })).providerID).toBe(
        downlink.providerID,
      )
    }),
  )

  it.effect("converges overlapping session failures and ignores a late success on the old provider", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const arrived = yield* Deferred.make<void>()
      const failures = yield* Deferred.make<void>()
      const lateStarted = yield* Deferred.make<void>()
      const lateRelease = yield* Deferred.make<void>()
      const calls: string[] = []
      yield* websearch.transform((editor) =>
        editor.add({
          id: WebSearch.ID.make("axis"),
          name: "Axis",
          execute: (input) =>
            Effect.gen(function* () {
              if (input.query === "seed") return []
              if (input.query === "late") {
                yield* Deferred.succeed(lateStarted, undefined)
                yield* Deferred.await(lateRelease)
                return []
              }
              calls.push(input.query)
              if (calls.length === 3) yield* Deferred.succeed(arrived, undefined)
              yield* Deferred.await(failures)
              return yield* TestWebSearch.httpError()
            }),
        }),
      )
      yield* websearch.select("random")
      yield* websearch.query({ query: "seed" }, { sessionID: firstSession })
      const late = yield* websearch.query({ query: "late" }, { sessionID: firstSession }).pipe(Effect.forkChild)
      yield* Deferred.await(lateStarted)
      yield* register("relay")
      yield* register("vector")
      const pending = yield* Effect.all(
        Array.from({ length: 3 }, (_, index) =>
          websearch.query({ query: `fail-${index}` }, { sessionID: firstSession }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      yield* Deferred.await(arrived)
      yield* Deferred.succeed(failures, undefined)
      const results = yield* Fiber.join(pending)
      expect(new Set(results.map((result) => result.providerID)).size).toBe(1)
      expect(results[0]?.providerID).not.toBe(WebSearch.ID.make("axis"))
      yield* Deferred.succeed(lateRelease, undefined)
      expect((yield* Fiber.join(late)).providerID).toBe(WebSearch.ID.make("axis"))
      expect((yield* websearch.query({ query: "later" }, { sessionID: firstSession })).providerID).toBe(
        results[0]?.providerID,
      )
    }),
  )

  it.effect("keeps fixed and explicit providers pinned with session context", () =>
    Effect.gen(function* () {
      const net = yield* register("axis")
      const downlink = yield* register("relay")
      const websearch = yield* WebSearch.Service
      net.failure.cause = TestWebSearch.httpError()
      yield* websearch.select(net.providerID)
      expect(yield* websearch.query({ query: "fixed" }, { sessionID: firstSession }).pipe(Effect.flip)).toMatchObject({
        providerID: net.providerID,
      })
      yield* websearch.select("random")
      expect(
        yield* websearch
          .query({ query: "explicit", providerID: net.providerID }, { sessionID: firstSession })
          .pipe(Effect.flip),
      ).toMatchObject({ providerID: net.providerID })
      expect(downlink.calls).toEqual([])
    }),
  )
  ;["delete", "move"].forEach((operation) => {
    it.effect(`forgets affinity on session ${operation} without retaining it through an in-flight query`, () =>
      Effect.gen(function* () {
        const net = yield* register("axis")
        const websearch = yield* WebSearch.Service
        const bus = yield* Bus.Service
        yield* websearch.select("random")
        yield* websearch.query({ query: "seed" }, { sessionID: firstSession })
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const pending = yield* websearch
          .query(
            { query: "pending" },
            {
              sessionID: firstSession,
              onProvider: (provider) =>
                provider.id === net.providerID
                  ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void,
            },
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* operation === "delete"
          ? bus.publish(SessionEvent.Deleted, { sessionID: firstSession })
          : bus.publish(SessionEvent.Moved, {
              sessionID: firstSession,
              location: { directory: AbsolutePath.make("/moved") },
              projectID: Project.ID.global,
            })
        yield* Effect.yieldNow
        yield* net.dispose
        const downlink = yield* register("relay")
        expect((yield* websearch.query({ query: "new affinity" }, { sessionID: firstSession })).providerID).toBe(
          downlink.providerID,
        )
        yield* downlink.dispose
        const vector = yield* register("vector")
        net.failure.cause = TestWebSearch.httpError()
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(pending)).providerID).toBe(vector.providerID)
        yield* register("relay")
        expect((yield* websearch.query({ query: "still new affinity" }, { sessionID: firstSession })).providerID).toBe(
          downlink.providerID,
        )
      }),
    )
  })

  it.effect("fails when web search is explicitly disabled", () =>
    Effect.gen(function* () {
      yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((editor) => editor.default.set(false))

      expect((yield* websearch.query({ query: "disabled" }).pipe(Effect.flip))._tag).toBe("WebSearch.Disabled")
    }),
  )

  it.effect("falls back when the configured default is unavailable", () =>
    Effect.gen(function* () {
      yield* register("axis")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((editor) => editor.default.set(WebSearch.ID.make("missing")))

      expect((yield* websearch.query({ query: "fallback" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
    }),
  )

  it.effect("removes scoped provider registrations", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const provider = yield* register("temporary").pipe(Scope.provide(scope))
      expect(yield* websearch.providers()).toContainEqual({ id: provider.providerID, name: "TEMPORARY" })
      yield* Scope.close(scope, Exit.void)
      expect(yield* websearch.providers()).not.toContainEqual({ id: provider.providerID, name: "TEMPORARY" })
    }),
  )
})
