import { describe, expect, test } from "bun:test"
import { goalResult, parseGoalArguments } from "../../src/session/prompt"

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
    expect(parseGoalArguments("'multi word goal'").update).toBe("multi word goal")
    expect(parseGoalArguments('"clear"').cleared).toBe(true)
    // interior quotes survive: only the wrapping layer is removed
    expect(parseGoalArguments('"say "hi" now"').text).toBe('say "hi" now')
  })

  test("only lowercase 'edit' is the subcommand: capitalized Edit is goal text", () => {
    const r = parseGoalArguments("Edit the README to add install steps")
    expect(r).toEqual({
      text: "Edit the README to add install steps",
      edit: false,
      update: "Edit the README to add install steps",
      showOnly: false,
      cleared: false,
    })
    for (const raw of ["EDIT the docs", "Edit"]) {
      const word = parseGoalArguments(raw)
      expect(word.edit).toBe(false)
      expect(word.showOnly).toBe(false)
      expect(word.update).toBe(raw)
    }
  })

  test("'edit' must be followed by whitespace or the end", () => {
    for (const raw of ["editorial cleanup", "edits to the parser", "edit-mode toggle", 'edit"x"']) {
      const r = parseGoalArguments(raw)
      expect(r.edit).toBe(false)
      expect(r.update).toBe(raw)
    }
    expect(parseGoalArguments("edit\tnew text").update).toBe("new text")
    expect(parseGoalArguments("edit\nmulti\nline").update).toBe("multi\nline")
    expect(parseGoalArguments("  edit  padded  ").update).toBe("padded")
  })

  test("a wholly quoted argument is literal goal text, even when it starts with edit", () => {
    for (const [raw, goal] of [
      ['"edit the README"', "edit the README"],
      ["'edit the README'", "edit the README"],
      ['"edit"', "edit"],
      [String.raw`"edit fix \"x\""`, 'edit fix "x"'],
    ]) {
      const r = parseGoalArguments(raw)
      expect(r.edit).toBe(false)
      expect(r.showOnly).toBe(false)
      expect(r.cleared).toBe(false)
      expect(r.update).toBe(goal)
    }
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

  test("run CLI escapes are decoded, not stored as literal backslashes", () => {
    // `opencode run --command goal 'say "hi" now'` arrives as "say \"hi\" now"
    expect(parseGoalArguments(String.raw`"say \"hi\" now"`).update).toBe('say "hi" now')
    // `opencode run --command goal edit 'fix "x"'` arrives as edit "fix \"x\""
    const edit = parseGoalArguments(String.raw`edit "fix \"x\""`)
    expect(edit.edit).toBe(true)
    expect(edit.update).toBe('fix "x"')
  })

  test("several separately quoted words keep their quotes balanced", () => {
    expect(parseGoalArguments('"a" "b"').update).toBe('"a" "b"')
    expect(parseGoalArguments('"a b" c "d e"').update).toBe('"a b" c "d e"')
    expect(parseGoalArguments('edit "a" "b"').update).toBe('"a" "b"')
    expect(parseGoalArguments(`'a' 'b'`).update).toBe(`'a' 'b'`)
  })

  test("goalResult reports the server-side outcome", () => {
    expect(goalResult(parseGoalArguments("fix all the bugs"))).toBe("set")
    expect(goalResult(parseGoalArguments("Edit the README"))).toBe("set")
    expect(goalResult(parseGoalArguments('"edit the README"'))).toBe("set")
    expect(goalResult(parseGoalArguments("edit new direction"))).toBe("updated")
    expect(goalResult(parseGoalArguments("edit clear"))).toBe("updated")
    expect(goalResult(parseGoalArguments("edit"))).toBe("unchanged")
    expect(goalResult(parseGoalArguments('edit ""'))).toBe("unchanged")
    expect(goalResult(parseGoalArguments(""))).toBe("unchanged")
    expect(goalResult(parseGoalArguments("clear"))).toBe("cleared")
    expect(goalResult(parseGoalArguments("None"))).toBe("cleared")
  })
})
