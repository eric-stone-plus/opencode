import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpCatalog } from "../../src/mcp/catalog"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-reconnect-stdio.ts")

const local = (environment?: Record<string, string>) => ({
  type: "local" as const,
  command: [process.execPath, fixture],
  environment,
})

const call = (tool: MCP.McpTool) =>
  Effect.tryPromise({
    try: () => tool.client.callTool({ name: tool.def.name, arguments: {} }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>)[0]?.text

const crash = (mcp: MCP.Interface, server: string) =>
  Effect.gen(function* () {
    const tools = yield* mcp.tools()
    yield* call(tools[`${server}_crash`]).pipe(Effect.ignore)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const status = (yield* mcp.status())[server]
        return status?.status === "failed" ? status : undefined
      }),
      "server did not report the closed connection",
    )
  })

describe("MCP reconnect", () => {
  test("reconnect delay doubles from 1s and caps at 5 minutes", () => {
    expect([1, 2, 3, 4].map(MCP.reconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(MCP.reconnectDelay(9)).toBe(256_000)
    expect(MCP.reconnectDelay(10)).toBe(300_000)
    expect(MCP.reconnectDelay(10_000)).toBe(300_000)
  })

  it.instance(
    "keeps tools registered while reconnecting and routes old handles to the new client",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("flaky", local())
        const before = yield* mcp.tools()
        const pid = text(yield* call(before.flaky_pid))

        yield* crash(mcp, "flaky")
        expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["flaky_crash", "flaky_pid"])
        const error = yield* call((yield* mcp.tools()).flaky_pid).pipe(Effect.flip)
        expect(error.message).toContain('MCP server "flaky" is reconnecting')

        yield* pollWithTimeout(
          Effect.gen(function* () {
            return (yield* mcp.status()).flaky?.status === "connected" ? true : undefined
          }),
          "server did not reconnect",
        )
        const after = text(yield* call((yield* mcp.tools()).flaky_pid))
        expect(after).not.toBe(pid)
        // A tool built before the crash resolves the current client at call time.
        expect(text(yield* call(before.flaky_pid))).toBe(after)
      }),
    { timeout: 20_000 },
  )

  it.instance(
    "keeps retrying while the server stays down",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const failFile = path.join(test.directory, "fail")
        const mcp = yield* MCP.Service
        yield* mcp.add("down", local({ MCP_RECONNECT_FAIL_FILE: failFile }))
        yield* Effect.promise(() => Bun.write(failFile, "1"))

        yield* crash(mcp, "down")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = (yield* mcp.status()).down
            return status?.status === "failed" && status.error.includes("attempt 2") ? true : undefined
          }),
          "first reconnect attempt did not fail and reschedule",
        )
        expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["down_crash", "down_pid"])

        yield* Effect.promise(() => fs.rm(failFile))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            return (yield* mcp.status()).down?.status === "connected" ? true : undefined
          }),
          "server did not reconnect once it came back",
          "10 seconds",
        )
        expect(text(yield* call((yield* mcp.tools()).down_pid))).toMatch(/^\d+$/)
      }),
    { timeout: 20_000 },
  )

  it.instance(
    "explicit disconnect cancels a pending reconnect",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("gone", local())
        yield* crash(mcp, "gone")
        yield* mcp.disconnect("gone")
        expect(yield* mcp.tools()).toEqual({})

        yield* Effect.sleep("1500 millis")
        expect((yield* mcp.status()).gone?.status).toBe("disabled")
        expect(yield* mcp.tools()).toEqual({})
      }),
    { timeout: 20_000 },
  )
})

describe("McpCatalog.callWithDeadline", () => {
  test("aborts a call that outlives the total deadline", async () => {
    let options: { signal?: AbortSignal; maxTotalTimeout?: number } | undefined
    const client = {
      callTool: (_params: unknown, _schema: unknown, opts: typeof options) => {
        options = opts
        return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason)))
      },
    } as unknown as Client

    await expect(McpCatalog.callWithDeadline(client, { name: "slow" }, undefined, undefined, 50)).rejects.toThrow(
      'MCP tool call "slow" exceeded the total timeout of 50ms',
    )
    expect(options?.maxTotalTimeout).toBe(50)
  })

  test("defaults to 10 minutes but never below the per-request timeout or above the timer limit", () => {
    expect(McpCatalog.maxTotalTimeout()).toBe(10 * 60_000)
    expect(McpCatalog.maxTotalTimeout(60_000)).toBe(10 * 60_000)
    expect(McpCatalog.maxTotalTimeout(20 * 60_000)).toBe(20 * 60_000)
    expect(McpCatalog.maxTotalTimeout(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647)
  })

  test("keeps the caller's abort signal", async () => {
    const caller = new AbortController()
    const client = {
      callTool: (_params: unknown, _schema: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("caller aborted")))),
    } as unknown as Client
    const pending = McpCatalog.callWithDeadline(client, { name: "slow" }, undefined, { signal: caller.signal })
    caller.abort()
    await expect(pending).rejects.toThrow("caller aborted")
  })
})
