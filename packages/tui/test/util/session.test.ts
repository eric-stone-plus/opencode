import { describe, expect, test } from "bun:test"
import { COMPACTION_PAGE, countCompactions, sessionFamily } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("counts a session's compactions without paging when the first page is short", async () => {
    const calls: Array<string | undefined> = []
    const count = await countCompactions(async (cursor) => {
      calls.push(cursor)
      return { data: Array.from({ length: 12 }, () => ({})), cursor: { next: "unused" } }
    })

    expect(count).toBe(12)
    expect(calls).toEqual([undefined])
  })

  test("follows the cursor while pages come back full", async () => {
    const calls: Array<string | undefined> = []
    const pages = [
      { data: Array.from({ length: COMPACTION_PAGE }, () => ({})), cursor: { next: "page-2" } },
      { data: Array.from({ length: COMPACTION_PAGE }, () => ({})), cursor: { next: "page-3" } },
      { data: Array.from({ length: 5 }, () => ({})), cursor: {} },
    ]
    const count = await countCompactions(async (cursor) => {
      calls.push(cursor)
      return pages[calls.length - 1]!
    })

    expect(count).toBe(COMPACTION_PAGE * 2 + 5)
    expect(calls).toEqual([undefined, "page-2", "page-3"])
  })

  test("stops when a full page carries no cursor, and counts nothing as zero", async () => {
    const full = Array.from({ length: COMPACTION_PAGE }, () => ({}))
    expect(await countCompactions(async () => ({ data: full, cursor: {} }))).toBe(COMPACTION_PAGE)
    expect(await countCompactions(async () => ({ data: [], cursor: { next: "ignored" } }))).toBe(0)
  })
})
