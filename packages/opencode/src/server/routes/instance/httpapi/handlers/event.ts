import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Cause, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

/**
 * Per-subscriber SSE buffer. Events are only queued while the client socket is
 * slower than the publishers, so this bounds memory held for a stalled client.
 */
export const SUBSCRIBER_CAPACITY = 4096

/**
 * Offers to a bounded subscriber queue. On overflow the queue is ended: the
 * buffered events still drain, then the SSE stream closes so the client
 * reconnects and re-hydrates instead of the server buffering without limit.
 * Returns true only for the offer that overflowed (later offers are dropped).
 */
export function offerOrEnd<A>(queue: Queue.Queue<A, Cause.Done>, value: A) {
  if (Queue.offerUnsafe(queue, value)) return false
  return Queue.endUnsafe(queue)
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    // Filter before enqueueing so other instances' traffic never occupies this
    // subscriber's bounded buffer.
    const queue = yield* Queue.dropping<EventV2.Payload, Cause.Done>(SUBSCRIBER_CAPACITY)
    const unsubscribe = yield* events.listen((event) =>
      Effect.suspend(() => {
        if (event.location?.directory !== instance.directory) return Effect.void
        if (event.location.workspaceID !== undefined && event.location.workspaceID !== workspaceID) return Effect.void
        if (!offerOrEnd(queue, event)) return Effect.void
        return Effect.logWarning("event subscriber overflowed, closing stream", { capacity: SUBSCRIBER_CAPACITY })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue))))
    const stream = Stream.fromQueue(queue).pipe(
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>(
      (queue) => {
        const listener = (event: {
          directory?: string
          payload: { id?: string; type?: string; properties?: unknown }
        }) => {
          if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
          offerOrEnd(queue, {
            id: event.payload.id ?? eventID(),
            type: "server.instance.disposed",
            properties: event.payload.properties ?? {},
          })
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listener)),
          () => Effect.sync(() => GlobalBus.off("event", listener)),
        )
      },
      { bufferSize: 16, strategy: "dropping" },
    )
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
