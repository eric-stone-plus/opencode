export * as JsonRpc from "./jsonrpc.js"

import { Deferred, Effect, Option, Schema } from "effect"

// A frame larger than this is a broken or hostile server, not a document the editor protocol needs to carry.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 8 * 1024
const METHOD_NOT_FOUND = -32601
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class RequestError extends Schema.TaggedError<RequestError>()("LSP.RequestError", {
  method: Schema.String,
  message: Schema.String,
}) {}

const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))
const contentLength = /^content-length:\s*(\d+)\s*$/im

export interface Connection {
  /** Resolves with the response `result`; fails on an error response, a timeout, or a closed connection. */
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, RequestError>
  readonly notify: (method: string, params?: unknown) => void
  /** Handlers run synchronously on the reader and must not throw. One handler per method. */
  readonly onNotification: (method: string, handler: (params: unknown) => void) => void
  /** The returned value is sent as the response result. One handler per method. */
  readonly onRequest: (method: string, handler: (params: unknown) => unknown) => void
  readonly feed: (chunk: Uint8Array) => void
  /** Fails every pending request and refuses new ones with `reason`. */
  readonly close: (reason: string) => void
}

const encode = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

/**
 * Incremental `Content-Length` frame splitter. Chunks are only joined once a complete frame is
 * buffered, so a large frame arriving in many chunks is not recopied for each of them.
 */
export const makeDecoder = (onFrame: (body: string) => void, onOverflow: (reason: string) => void) => {
  const state = { chunks: [] as Buffer[], size: 0, frame: undefined as { start: number; length: number } | undefined }

  const joined = () => {
    if (state.chunks.length > 1) state.chunks = [Buffer.concat(state.chunks)]
    return state.chunks[0] ?? Buffer.alloc(0)
  }

  const push = (chunk: Uint8Array) => {
    state.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    state.size += chunk.byteLength
    while (true) {
      if (state.frame === undefined) {
        const all = joined()
        const end = all.indexOf("\r\n\r\n")
        if (end === -1) {
          if (state.size > MAX_HEADER_BYTES) return onOverflow("LSP header exceeded the size limit")
          return
        }
        const length = Number(contentLength.exec(all.subarray(0, end).toString("ascii"))?.[1])
        if (!Number.isFinite(length)) {
          // A header block without a usable length cannot be framed; resynchronise after it.
          state.chunks = [all.subarray(end + 4)]
          state.size = state.chunks[0].length
          continue
        }
        if (length > MAX_FRAME_BYTES) return onOverflow("LSP frame exceeded the size limit")
        state.frame = { start: end + 4, length }
      }
      if (state.size < state.frame.start + state.frame.length) return
      const all = joined()
      const end = state.frame.start + state.frame.length
      const body = all.subarray(state.frame.start, end).toString("utf8")
      const rest = all.subarray(end)
      state.chunks = rest.length > 0 ? [rest] : []
      state.size = rest.length
      state.frame = undefined
      onFrame(body)
    }
  }

  return push
}

export interface Options {
  readonly write: (frame: Uint8Array) => void
  /** Names the peer in error messages. */
  readonly label: string
  readonly onOverflow?: (reason: string) => void
}

export const make = (options: Options): Connection => {
  const pending = new Map<string | number, { method: string; deferred: Deferred.Deferred<unknown, RequestError> }>()
  const notifications = new Map<string, (params: unknown) => void>()
  const requests = new Map<string, (params: unknown) => unknown>()
  const state = { id: 0, closed: undefined as string | undefined }

  const send = (message: Record<string, unknown>) => options.write(encode({ jsonrpc: "2.0", ...message }))

  const dispatch = (body: string) => {
    const message = Option.getOrUndefined(decodeMessage(body))
    if (!message) return
    if (message.method !== undefined) {
      if (message.id === undefined) return notifications.get(message.method)?.(message.params)
      const handler = requests.get(message.method)
      if (!handler)
        return send({
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        })
      return send({ id: message.id, result: handler(message.params) ?? null })
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    Deferred.doneUnsafe(
      entry.deferred,
      message.error
        ? Effect.fail(new RequestError({ method: entry.method, message: `${message.error.message} (code ${message.error.code})` }))
        : Effect.succeed(message.result ?? null),
    )
  }

  const request: Connection["request"] = (method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) =>
    Effect.gen(function* () {
      if (state.closed !== undefined) return yield* new RequestError({ method, message: state.closed })
      const id = ++state.id
      const deferred = yield* Deferred.make<unknown, RequestError>()
      pending.set(id, { method, deferred })
      send({ id, method, params })
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new RequestError({
                method,
                message: `LSP request ${method} to ${options.label} timed out after ${timeoutMs}ms`,
              }),
            ),
        }),
        // A response removes its own entry; anything still pending was abandoned, so tell the server to stop.
        Effect.onExit(() =>
          Effect.sync(() => {
            if (pending.delete(id)) send({ method: "$/cancelRequest", params: { id } })
          }),
        ),
      )
    })

  return {
    request,
    notify: (method, params) => {
      if (state.closed === undefined) send({ method, params })
    },
    onNotification: (method, handler) => {
      notifications.set(method, handler)
    },
    onRequest: (method, handler) => {
      requests.set(method, handler)
    },
    feed: makeDecoder(dispatch, options.onOverflow ?? (() => {})),
    close: (reason) => {
      if (state.closed !== undefined) return
      state.closed = reason
      for (const entry of pending.values())
        Deferred.doneUnsafe(entry.deferred, Effect.fail(new RequestError({ method: entry.method, message: reason })))
      pending.clear()
    },
  }
}
