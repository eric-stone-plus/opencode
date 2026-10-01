import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )

  it.effect("drops finished jobs after the retention window", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const job = yield* jobs.start({ type: "test", run: Effect.succeed("x".repeat(1024)) })
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({ info: { status: "completed" } })
      // Still observable right after settling (late wait/get callers).
      expect((yield* jobs.get(job.id))?.output).toHaveLength(1024)

      yield* TestClock.adjust(Duration.sum(BackgroundJob.FINISHED_RETENTION, Duration.seconds(1)))
      expect(yield* jobs.get(job.id)).toBeUndefined()
      expect(yield* jobs.list()).toEqual([])
    }),
  )

  it.effect("drops cancelled jobs after the retention window", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const job = yield* jobs.start({ type: "test", run: Effect.never })
      expect((yield* jobs.cancel(job.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")

      yield* TestClock.adjust(Duration.sum(BackgroundJob.FINISHED_RETENTION, Duration.seconds(1)))
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }),
  )

  it.effect("caps retained finished jobs, evicting the oldest first", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const total = BackgroundJob.FINISHED_MAX + 5
      yield* Effect.forEach(Array.from({ length: total }), (_, index) =>
        jobs
          .start({ id: `job_cap_${index}`, type: "test", run: Effect.succeed(String(index)) })
          .pipe(Effect.flatMap((job) => jobs.wait({ id: job.id }))),
      )
      const ids = (yield* jobs.list()).map((job) => job.id)
      expect(ids).toHaveLength(BackgroundJob.FINISHED_MAX)
      expect(ids).not.toContain("job_cap_0")
      expect(ids).toContain(`job_cap_${total - 1}`)
    }),
  )

  it.effect("never evicts a running job that reused a finished id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      yield* jobs.start({ id: "job_reuse", type: "test", run: Effect.succeed("first") })
      expect(yield* jobs.wait({ id: "job_reuse" })).toMatchObject({ info: { status: "completed" } })

      const latch = yield* Deferred.make<void>()
      yield* jobs.start({ id: "job_reuse", type: "test", run: Deferred.await(latch).pipe(Effect.as("second")) })
      yield* TestClock.adjust(Duration.sum(BackgroundJob.FINISHED_RETENTION, Duration.seconds(1)))
      expect((yield* jobs.get("job_reuse"))?.status).toBe("running")

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: "job_reuse" })).toMatchObject({ info: { status: "completed", output: "second" } })
    }),
  )

  it.effect("keeps returned snapshots stable across later updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const before = yield* jobs.list()
      const waiter = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild)
      yield* Deferred.succeed(latch, undefined)
      yield* Fiber.join(waiter)
      expect(before[0]?.status).toBe("running")
      expect((yield* jobs.get(job.id))?.status).toBe("completed")
    }),
  )
})
