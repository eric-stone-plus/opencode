import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { offerOrEnd, SUBSCRIBER_CAPACITY } from "./event"
import { GlobalUpgradeInput } from "../groups/global"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    // Bounded per-subscriber buffer: a stalled client ends its stream (and
    // reconnects) instead of growing server memory without limit.
    let overflowed = false
    const events = Stream.callback<GlobalBusEvent>(
      (queue) => {
        const handler = (event: GlobalBusEvent) => {
          if (offerOrEnd(queue, event)) overflowed = true
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", handler)),
          () => Effect.sync(() => GlobalBus.off("event", handler)),
        )
      },
      { bufferSize: SUBSCRIBER_CAPACITY, strategy: "dropping" },
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(
          Effect.suspend(() =>
            overflowed
              ? Effect.logWarning("global event subscriber overflowed, stream closed", {
                  capacity: SUBSCRIBER_CAPACITY,
                })
              : Effect.logInfo("global event disconnected"),
          ),
        ),
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

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    // Personal fork: the running binary is built from source, and every
    // Installation.upgrade method would overwrite it with an upstream release.
    // The route stays in the API (typed clients and the TUI still call it) but
    // always refuses; updates go through `bun run sync-upstream`.
    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (_ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      return HttpServerResponse.jsonUnsafe(
        {
          success: false as const,
          error: "Upgrades are disabled in this build; update it with `bun run sync-upstream`",
        },
        { status: 403 },
      )
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
