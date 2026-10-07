import { describe, expect, test } from "bun:test"

const template = await Bun.file(new URL("../../src/command/template/review.txt", import.meta.url)).text()

describe("review command template", () => {
  test("declares the coverage ledger contract", () => {
    expect(template).toContain("Coverage Ledger")
    expect(template).toContain("exactly once")
    expect(template).toContain("skipped: <reason>")
    expect(template).toContain("reviewed")
    expect(template).toContain("untracked")
    expect(template).toContain("file by file")
    expect(template).toContain("50KB")
  })

  test("declares the structured finding fields", () => {
    for (const field of ["file", "line", "severity", "category", "title", "description", "fix"]) {
      expect(template).toContain(`**${field}**`)
    }
    expect(template).toContain("high | med | low")
    expect(template).toContain("bug | security | behavior-change | structure | performance")
    expect(template).toContain("Position Accuracy")
  })

  test("declares the summary block and deterministic verdict", () => {
    expect(template).toContain("Counts: high N | med N | low N")
    expect(template).toContain("approve | approve-with-nits | needs-fixes")
  })

  test("keeps input routing and three-dot branch semantics", () => {
    expect(template).toContain("git diff $ARGUMENTS...HEAD")
    expect(template).toContain("git show $ARGUMENTS")
    expect(template).toContain("gh pr diff $ARGUMENTS")
    expect(template).toContain("read the entire file(s) being modified")
  })

  test("core CommandPlugin copy stays byte-identical (v2 command.list serves it)", async () => {
    const core = await Bun.file(new URL("../../../core/src/plugin/command/review.txt", import.meta.url)).text()
    expect(core).toBe(template)
  })
})
