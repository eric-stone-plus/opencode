import { describe, expect, test } from "bun:test"
import { JsonRpc } from "@opencode/core/fork/lsp/jsonrpc"

const frame = (body: string) => {
  const payload = Buffer.from(body, "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload])
}

const parse = (written: Uint8Array[]) => {
  const messages: unknown[] = []
  let rest = Buffer.concat(written)
  for (;;) {
    const end = rest.indexOf("\r\n\r\n")
    if (end === -1) break
    const length = Number(/content-length:\s*(\d+)/i.exec(rest.subarray(0, end).toString("ascii"))?.[1])
    if (!Number.isFinite(length) || rest.length < end + 4 + length) break
    messages.push(JSON.parse(rest.subarray(end + 4, end + 4 + length).toString("utf8")))
    rest = rest.subarray(end + 4 + length)
  }
  return messages
}

describe("LSP frame decoder", () => {
  test("delivers a framed message across split chunks", () => {
    const bodies: string[] = []
    const push = JsonRpc.makeDecoder(
      (body) => bodies.push(body),
      () => {},
    )
    const bytes = frame('{"jsonrpc":"2.0","method":"a"}')
    push(bytes.subarray(0, 5))
    push(bytes.subarray(5))
    expect(bodies).toEqual(['{"jsonrpc":"2.0","method":"a"}'])
  })

  // A hostile server can declare a frame beyond the limit and keep writing. The reader only stops on a
  // later chunk (or on server exit, which a hostile one need not do), so the decoder has to refuse the
  // desynchronised stream itself rather than re-parse the same header and accumulate the chunks.
  test("refuses further bytes after an oversized frame instead of growing its buffer", () => {
    const overflows: string[] = []
    const bodies: string[] = []
    const push = JsonRpc.makeDecoder(
      (body) => bodies.push(body),
      (reason) => overflows.push(reason),
    )
    push(Buffer.from(`Content-Length: ${Number.MAX_SAFE_INTEGER}\r\n\r\n`, "ascii"))
    push(Buffer.from("x".repeat(4096), "ascii"))
    push(Buffer.from("x".repeat(4096), "ascii"))
    expect(overflows).toEqual(["LSP frame exceeded the size limit"])
    push(frame('{"jsonrpc":"2.0","method":"late"}'))
    expect(bodies).toEqual([])
  })

  test("copies each chunk so the caller may reuse its buffer after feeding", () => {
    const bodies: string[] = []
    const push = JsonRpc.makeDecoder(
      (body) => bodies.push(body),
      () => {},
    )
    const bytes = frame('{"jsonrpc":"2.0","method":"a"}')
    const head = bytes.subarray(0, 5)
    push(head)
    // A pooled socket read hands the same memory out again once its reader is done with it.
    head.fill(0x78)
    push(bytes.subarray(5))
    expect(bodies).toEqual(['{"jsonrpc":"2.0","method":"a"}'])
  })

  test("refuses a header block that exceeds the limit once its terminator arrives", () => {
    const overflows: string[] = []
    const bodies: string[] = []
    const push = JsonRpc.makeDecoder(
      (body) => bodies.push(body),
      (reason) => overflows.push(reason),
    )
    push(Buffer.from(`Content-Length: 2\r\nX-Pad: ${"x".repeat(9_000)}\r\n\r\n{}`, "ascii"))
    expect(overflows).toEqual(["LSP header exceeded the size limit"])
    expect(bodies).toEqual([])
  })
})

describe("LSP JSON-RPC connection", () => {
  test("isolates a throwing request handler and keeps processing the frames behind it", () => {
    const written: Uint8Array[] = []
    const connection = JsonRpc.make({ write: (bytes) => written.push(bytes), label: "test", onOverflow: () => {} })
    connection.onRequest("boom", () => {
      throw new Error("handler exploded")
    })
    connection.onRequest("echo", () => "ok")
    connection.feed(
      Buffer.concat([frame('{"jsonrpc":"2.0","id":1,"method":"boom"}'), frame('{"jsonrpc":"2.0","id":2,"method":"echo"}')]),
    )
    expect(parse(written)).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Handler for boom failed: handler exploded" } },
      { jsonrpc: "2.0", id: 2, result: "ok" },
    ])
  })

  test("isolates a throwing notification handler so later frames still arrive", () => {
    const written: Uint8Array[] = []
    const connection = JsonRpc.make({ write: (bytes) => written.push(bytes), label: "test", onOverflow: () => {} })
    connection.onNotification("note", () => {
      throw new Error("nope")
    })
    connection.onRequest("echo", () => "ok")
    connection.feed(Buffer.concat([frame('{"jsonrpc":"2.0","method":"note"}'), frame('{"jsonrpc":"2.0","id":3,"method":"echo"}')]))
    expect(parse(written)).toEqual([{ jsonrpc: "2.0", id: 3, result: "ok" }])
  })

  test("answers an internal error when a handler returns a promise", () => {
    const written: Uint8Array[] = []
    const connection = JsonRpc.make({ write: (bytes) => written.push(bytes), label: "test", onOverflow: () => {} })
    connection.onRequest("later", () => Promise.resolve("eventually"))
    connection.feed(frame('{"jsonrpc":"2.0","id":4,"method":"later"}'))
    expect(parse(written)).toEqual([
      { jsonrpc: "2.0", id: 4, error: { code: -32603, message: "Handler for later failed: handler returned a promise" } },
    ])
  })

  test("stops writing responses and processing frames after close", () => {
    const written: Uint8Array[] = []
    const connection = JsonRpc.make({ write: (bytes) => written.push(bytes), label: "test", onOverflow: () => {} })
    const calls: string[] = []
    connection.onRequest("echo", () => {
      calls.push("echo")
      return "ok"
    })
    connection.feed(frame('{"jsonrpc":"2.0","id":1,"method":"echo"}'))
    expect(parse(written)).toEqual([{ jsonrpc: "2.0", id: 1, result: "ok" }])
    connection.close("server exited")
    connection.feed(frame('{"jsonrpc":"2.0","id":2,"method":"echo"}'))
    expect(parse(written)).toHaveLength(1)
    expect(calls).toEqual(["echo"])
  })
})
