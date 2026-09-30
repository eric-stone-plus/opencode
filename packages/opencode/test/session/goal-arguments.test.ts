import { describe, expect, test } from "bun:test"
import { parseGoalArguments } from "../../src/session/prompt"

describe("parseGoalArguments", () => {
  test("non-empty text sets the goal and routes to the goal agent", () => {
    const r = parseGoalArguments("fix all the bugs")
    expect(r).toEqual({ text: "fix all the bugs", edit: false, update: "fix all the bugs", showOnly: false, cleared: false })
  })

  test("bare clear/none/remove clears", () => {
    for (const word of ["clear", "none", "remove", "CLEAR", "Remove"]) {
      const r = parseGoalArguments(word)
      expect(r.cleared).toBe(true)
      expect(r.showOnly).toBe(false)
      expect(r.edit).toBe(false)
    }
  })

  test("'/goal edit clear' stores the literal word instead of clearing", () => {
    const r = parseGoalArguments("edit clear")
    expect(r.cleared).toBe(false)
    expect(r.edit).toBe(true)
    expect(r.update).toBe("clear")
    expect(r.showOnly).toBe(false)
  })

  test("'/goal edit <text>' replaces the goal text", () => {
    const r = parseGoalArguments("edit new direction")
    expect(r).toEqual({ text: "edit new direction", edit: true, update: "new direction", showOnly: false, cleared: false })
  })

  test("bare '/goal edit' is show-only", () => {
    const r = parseGoalArguments("edit")
    expect(r.edit).toBe(true)
    expect(r.showOnly).toBe(true)
    expect(r.update).toBe("")
    expect(r.cleared).toBe(false)
  })

  test("empty argument is show-only and never clears", () => {
    for (const raw of ["", "   "]) {
      const r = parseGoalArguments(raw)
      expect(r.showOnly).toBe(true)
      expect(r.cleared).toBe(false)
      expect(r.update).toBe("")
    }
  })

  test("one wrapping quote layer is stripped (run CLI argv quoting)", () => {
    expect(parseGoalArguments('"edit the goal"').update).toBe("the goal")
    expect(parseGoalArguments("'multi word goal'").update).toBe("multi word goal")
    expect(parseGoalArguments('"clear"').cleared).toBe(true)
    // interior quotes survive: only the wrapping layer is removed
    expect(parseGoalArguments('"say "hi" now"').text).toBe('say "hi" now')
  })

  test("case-insensitive edit prefix", () => {
    const r = parseGoalArguments("Edit Mixed Case")
    expect(r.edit).toBe(true)
    expect(r.update).toBe("Mixed Case")
  })

  test("quoted empty update is show-only, not the literal quote pair", () => {
    for (const raw of ['edit ""', "edit ''", 'edit "   "']) {
      const r = parseGoalArguments(raw)
      expect(r.edit).toBe(true)
      expect(r.showOnly).toBe(true)
      expect(r.update).toBe("")
    }
  })

  test("quoted edit update strips one wrapping quote layer", () => {
    expect(parseGoalArguments('edit "new direction"').update).toBe("new direction")
    expect(parseGoalArguments("edit 'new direction'").update).toBe("new direction")
  })
})
