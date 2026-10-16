import { describe, expect, test } from "bun:test"
import { JsonRpc } from "@opencode/core/fork/lsp/jsonrpc"

const frame = (body: string) => {
  const payload = Buffer.from(body, "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload])
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
})
