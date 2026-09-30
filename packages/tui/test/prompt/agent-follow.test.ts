import { describe, expect, test } from "bun:test"
import { followAgent } from "../../src/prompt/agent-follow"

describe("prompt agent follow", () => {
  const start = { messageID: "m1", agent: "auto" }

  test("follows a server-side agent switch", () => {
    expect(followAgent(start, { id: "m2", agent: "goal" }).agent).toBe("goal")
    expect(followAgent({ messageID: "m2", agent: "goal" }, { id: "m3", agent: "auto" }).agent).toBe("auto")
  })

  test("a continuation that copies the previous agent keeps the user's pick", () => {
    // user switched the selector to plan; compaction auto-continue arrives as auto
    const next = followAgent(start, { id: "m2", agent: "auto" })
    expect(next.agent).toBeUndefined()
    expect(next.state).toEqual({ messageID: "m2", agent: "auto" })
  })

  test("the same message never re-applies", () => {
    expect(followAgent(start, { id: "m1", agent: "goal" })).toEqual({ state: start })
  })

  test("a message without an agent changes nothing", () => {
    expect(followAgent(start, { id: "m2" }).agent).toBeUndefined()
  })
})
