export * as JsonRpc from "./jsonrpc.js"

import { Deferred, Effect, Option, Schema } from "effect"

// A frame larger than this is a broken or hostile server, not a document the editor protocol needs to carry.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 8 * 1024
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
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
  /** The returned value is sent as the response result; it must be synchronous and JSON-serializable. */
  readonly onRequest: (method: string, handler: (params: unknown) => unknown) => void
  /** Ignored once the connection is closed. */
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
 * buffered, so a large frame arriving in many chunks is not recopied for each of them. Each chunk is
 * copied on receipt, so the caller owns its memory again the moment `feed` returns.
 */
export const makeDecoder = (onFrame: (body: string) => void, onOverflow: (reason: string) => void) => {
  const state = {
    chunks: [] as Buffer[],
    size: 0,
    frame: undefined as { start: number; length: number } | undefined,
    broken: false,
  }

  const joined = () => {
    if (state.chunks.length > 1) state.chunks = [Buffer.concat(state.chunks)]
    return state.chunks[0] ?? Buffer.alloc(0)
  }

  // An overflow leaves the stream desynchronised, and the reader only stops on the next chunk (or when the
  // server exits, which a hostile one need not do): the decoder drops its buffer and refuses further input
  // instead of re-parsing the same oversized header while the reader keeps appending to it.
  const fail = (reason: string) => {
    state.broken = true
    state.chunks = []
    state.size = 0
    state.frame = undefined
    onOverflow(reason)
  }

  const push = (chunk: Uint8Array) => {
    if (state.broken) return
    state.chunks.push(Buffer.from(chunk))
    state.size += chunk.byteLength
    while (true) {
      if (state.frame === undefined) {
        const all = joined()
        const end = all.indexOf("\r\n\r\n")
        if (end === -1) {
          if (state.size > MAX_HEADER_BYTES) return fail("LSP header exceeded the size limit")
          return
        }
        // The chunked check above cannot see a whole oversized header that arrives in one chunk.
        if (end > MAX_HEADER_BYTES) return fail("LSP header exceeded the size limit")
        const length = Number(contentLength.exec(all.subarray(0, end).toString("ascii"))?.[1])
        if (!Number.isFinite(length)) {
          // A header block without a usable length cannot be framed; resynchronise after it.
          state.chunks = [all.subarray(end + 4)]
          state.size = state.chunks[0].length
          continue
        }
        if (length > MAX_FRAME_BYTES) return fail("LSP frame exceeded the size limit")
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
  /** Called once when the decoder refuses the stream; the connection owner decides what dying means. */
  readonly onOverflow: (reason: string) => void
}

export const make = (options: Options): Connection => {
  const pending = new Map<string | number, { method: string; deferred: Deferred.Deferred<unknown, RequestError> }>()
  const notifications = new Map<string, (params: unknown) => void>()
  const requests = new Map<string, (params: unknown) => unknown>()
  const state = { id: 0, closed: undefined as string | undefined }

  const send = (message: Record<string, unknown>) => {
    if (state.closed !== undefined) return
    options.write(encode({ jsonrpc: "2.0", ...message }))
  }

  const dispatch = (body: string) => {
    const message = Option.getOrUndefined(decodeMessage(body))
    if (!message) return
    if (message.method !== undefined) {
      if (message.id === undefined) {
        // A notification has no reply; swallowing a throwing handler keeps the frames buffered behind
        // it alive instead of abandoning them on the reader.
        try {
          notifications.get(message.method)?.(message.params)
        } catch {
          return
        }
        return
      }
      const handler = requests.get(message.method)
      if (!handler)
        return send({
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        })
      let result: unknown
      try {
        result = handler(message.params)
        // A promise would serialize as `{}` and lie to the server about the result.
        if (result instanceof Promise) throw new Error("handler returned a promise")
      } catch (error) {
        return send({
          id: message.id,
          error: {
            code: INTERNAL_ERROR,
            message: `Handler for ${message.method} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        })
      }
      return send({ id: message.id, result: result ?? null })
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

  const decoder = makeDecoder(dispatch, options.onOverflow)

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
    // A closed connection is over: frames arriving after it are the peer's (or a pooled reader's)
    // leftovers and must not reach handlers or the wire.
    feed: (chunk) => {
      if (state.closed !== undefined) return
      decoder(chunk)
    },
    close: (reason) => {
      if (state.closed !== undefined) return
      state.closed = reason
      for (const entry of pending.values())
        Deferred.doneUnsafe(entry.deferred, Effect.fail(new RequestError({ method: entry.method, message: reason })))
      pending.clear()
    },
  }
}
