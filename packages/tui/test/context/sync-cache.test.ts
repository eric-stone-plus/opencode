import { describe, expect, test } from "bun:test"
import { createSessionLRU, knownMessage, protectedSessions, sessionsToEvict } from "../../src/context/sync-cache"

describe("sync session cache", () => {
  test("LRU orders oldest first and reports first touches", () => {
    const lru = createSessionLRU()
    expect(lru.touch("a")).toBe(true)
    expect(lru.touch("b")).toBe(true)
    expect(lru.touch("a")).toBe(false)
    expect(lru.keys()).toEqual(["b", "a"])
    lru.delete("b")
    expect(lru.keys()).toEqual(["a"])
  })

  test("evicts only the oldest unprotected sessions beyond the limit", () => {
    const order = ["s1", "route", "s2", "s3", "s4"]
    expect(sessionsToEvict({ order, keep: new Set(["route"]), max: 2 })).toEqual(["s1", "s2"])
    expect(sessionsToEvict({ order, keep: new Set(["route"]), max: 10 })).toEqual([])
  })

  test("protects the route session, its parent and their busy children", () => {
    const sessions = [
      { id: "root" },
      { id: "child", parentID: "root" },
      { id: "sibling", parentID: "root" },
      { id: "done", parentID: "root" },
      { id: "elsewhere", parentID: "other" },
    ]
    const busy = (id: string) => id !== "done"
    expect([...protectedSessions({ route: "root", sessions, busy })].sort()).toEqual(["child", "root", "sibling"])
    expect([...protectedSessions({ route: "child", sessions, busy })].sort()).toEqual(["child", "root", "sibling"])
    expect(protectedSessions({ route: undefined, sessions, busy }).size).toBe(0)
  })

  test("knownMessage requires a resident message", () => {
    expect(knownMessage(undefined, "m")).toBe(false)
    expect(knownMessage([{ id: "x" }], "m")).toBe(false)
    expect(knownMessage([{ id: "m" }], "m")).toBe(true)
  })
})
