import { describe, expect, test } from "bun:test"
import { Cause, Effect, Fiber, Queue, Stream } from "effect"
import { offerOrEnd, SUBSCRIBER_CAPACITY } from "../../src/server/routes/instance/httpapi/handlers/event"

describe("SSE subscriber overflow", () => {
  test("ends a full subscriber queue after its buffered events drain", async () => {
    const result = await Effect.gen(function* () {
      const queue = yield* Queue.dropping<number, Cause.Done>(3)
      const overflowed = [1, 2, 3, 4, 5].map((value) => offerOrEnd(queue, value))
      // Only the first rejected offer reports the overflow; later ones are dropped.
      expect(overflowed).toEqual([false, false, false, true, false])
      return yield* Stream.fromQueue(queue).pipe(Stream.runCollect)
    }).pipe(Effect.runPromise)
    expect(Array.from(result)).toEqual([1, 2, 3])
  })

  test("a stalled callback stream closes on overflow instead of growing", async () => {
    const result = await Effect.gen(function* () {
      const offers: Array<(value: number) => boolean> = []
      const stream = Stream.callback<number>(
        (queue) =>
          Effect.sync(() => {
            offers.push((value) => offerOrEnd(queue, value))
          }),
        { bufferSize: 2, strategy: "dropping" },
      )
      const fiber = yield* stream.pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      while (offers.length === 0) yield* Effect.yieldNow
      const publish = offers[0]
      // Publish faster than the consumer can drain in this tick.
      const flags = Array.from({ length: 10 }, (_, index) => publish(index))
      expect(flags.filter(Boolean)).toHaveLength(1)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.scoped, Effect.runPromise)
    // The stream terminated (runCollect returned) with only the buffered prefix.
    expect(Array.from(result)).toEqual([0, 1])
  })

  test("bounds the per-subscriber buffer", () => {
    expect(SUBSCRIBER_CAPACITY).toBeGreaterThan(0)
    expect(Number.isFinite(SUBSCRIBER_CAPACITY)).toBe(true)
  })
})
