// Prefix drift attribution (borrow C1). These tests are the byte-level simulation: the fingerprint is
// stable while the prefix bytes are, the first changed part is named with how many matched before it,
// and appending a turn is not drift - an extension still hits the provider cache.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart } from "@opencode/ai"
import { drift, fingerprint, PREFIX_MESSAGES, prefixOf } from "@opencode/core/session/fork/prefix-drift"

const system = (text: string) => SystemPart.make(text)
const user = (text: string) => Message.make({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string) => Message.make({ role: "assistant", content: [{ type: "text", text }] })

const request = (systemTexts: string[], messages: ReturnType<typeof user>[]) => ({
  system: systemTexts.map(system),
  messages,
})

describe("prefixOf", () => {
  test("labels system parts and leading messages in order", () => {
    const prefix = prefixOf(request(["instructions", "autonomy contract"], [user("one"), assistant("two")]))
    expect(prefix.map((part) => part.label)).toEqual([
      "system[0]",
      "system[1]",
      "message[0]:user",
      "message[1]:assistant",
    ])
  })

  test("stops at the prefix window, so a long history does not pin every byte", () => {
    const messages = Array.from({ length: PREFIX_MESSAGES + 4 }, (_, index) => user(`turn ${index}`))
    const prefix = prefixOf(request([], messages))
    expect(prefix).toHaveLength(PREFIX_MESSAGES)
    expect(prefix.at(-1)?.label).toBe(`message[${PREFIX_MESSAGES - 1}]:user`)
  })
})

describe("drift", () => {
  test("reports nothing when the bytes are identical", () => {
    const first = prefixOf(request(["instructions"], [user("one")]))
    const second = prefixOf(request(["instructions"], [user("one")]))
    expect(drift(first, second)).toBeUndefined()
    expect(fingerprint(first)).toBe(fingerprint(second))
  })

  test("reports nothing when the new request only extends the prefix", () => {
    const first = prefixOf(request(["instructions"], [user("one")]))
    const second = prefixOf(request(["instructions"], [user("one"), assistant("two")]))
    expect(drift(first, second)).toBeUndefined()
    // The fingerprint does change: the cache still pays for the shared part, and the log says so.
    expect(fingerprint(first)).not.toBe(fingerprint(second))
  })

  test("names the first part that moved, and how much of the prefix survived", () => {
    const first = prefixOf(request(["instructions", "autonomy contract"], [user("one"), user("two")]))
    const second = prefixOf(request(["instructions", "autonomy contract"], [user("one"), user("two!"), user("three")]))
    expect(drift(first, second)).toEqual({ at: "message[1]:user", matched: 3 })
  })

  test("catches a one byte change in a long shared prefix", () => {
    const long = "x".repeat(20_000)
    const first = prefixOf(request([long], [user(long)]))
    const second = prefixOf(request([`${long.slice(0, -1)}y`], [user(long)]))
    expect(drift(first, second)).toEqual({ at: "system[0]", matched: 0 })
    expect(fingerprint(first)).not.toBe(fingerprint(second))
  })

  test("treats a rewritten prefix, as compaction produces, as drift at its first part", () => {
    const first = prefixOf(request(["instructions"], [user("one"), user("two"), user("three")]))
    const second = prefixOf(request(["instructions"], [user("summary")]))
    expect(drift(first, second)).toEqual({ at: "message[0]:user", matched: 1 })
  })
})
