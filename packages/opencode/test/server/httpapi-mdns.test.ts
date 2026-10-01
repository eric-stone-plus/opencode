import { afterEach, describe, expect, mock, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

type Event = { kind: "publish"; port: number; name: string } | { kind: "unpublishAll" } | { kind: "destroy" }
const events: Event[] = []

void mock.module("bonjour-service", () => ({
  Bonjour: class {
    publish(opts: { port: number; name: string }) {
      events.push({ kind: "publish", port: opts.port, name: opts.name })
      return { on: () => {} }
    }
    unpublishAll() {
      events.push({ kind: "unpublishAll" })
    }
    destroy() {
      events.push({ kind: "destroy" })
    }
  },
}))

// Import Server AFTER the mock so the MDNS module picks up the stub.
const { Server } = await import("../../src/server/server")

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
}

// Non-loopback listeners refuse to start unless the env password is set.
function setPassword(value: string) {
  Flag.OPENCODE_SERVER_PASSWORD = value
  Flag.OPENCODE_SERVER_USERNAME = "opencode"
  process.env.OPENCODE_SERVER_PASSWORD = value
}

afterEach(async () => {
  events.length = 0
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi Server.listen mDNS", () => {
  test("skips publish for loopback hostnames", async () => {
    setPassword("mdns-secret")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: true })
    try {
      expect(events.filter((e) => e.kind === "publish")).toEqual([])
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping loopback mdns listener")
    }
    expect(events.filter((e) => e.kind === "publish")).toEqual([])
  })

  test("publishes for non-loopback hostnames and unpublishes on stop", async () => {
    setPassword("mdns-secret")
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    try {
      const published = events.filter((e) => e.kind === "publish")
      expect(published.length).toBe(1)
      expect(published[0]!.port).toBe(listener.port)
      expect(published[0]!.name).toBe(`opencode-${listener.port}`)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping mdns listener")
    }
    expect(events.some((e) => e.kind === "unpublishAll")).toBe(true)
    expect(events.some((e) => e.kind === "destroy")).toBe(true)
  })

  test("refuses non-loopback hostnames without a server password", async () => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    for (const hostname of ["0.0.0.0", "192.168.1.20", "::"]) {
      await expect(Server.listen({ hostname, port: 0, mdns: true })).rejects.toThrow(/without OPENCODE_SERVER_PASSWORD/)
    }
    expect(events.filter((e) => e.kind === "publish")).toEqual([])
  })

  test("scope finalizer unpublishes even if stop() is not called for force-close", async () => {
    setPassword("mdns-secret")
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    expect(events.filter((e) => e.kind === "publish").length).toBe(1)
    // Plain (graceful) stop without close=true should still unpublish.
    await withTimeout(listener.stop(), 10_000, "timed out stopping graceful mdns listener")
    expect(events.some((e) => e.kind === "unpublishAll")).toBe(true)
  })
})
