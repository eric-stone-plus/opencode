import { describe, expect, test } from "bun:test"
import {
  createDialogSessionListQuery,
  loadDialogSessionList,
  sessionRowFooter,
} from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("requests root sessions for the default browse list", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
      search: "deploy",
      scope: "project",
    })
  })

  test("keeps the cache usable while the root request is pending", async () => {
    let resolve!: (result: { data: string[] }) => void
    const pending = loadDialogSessionList<string>({
      filter: {},
      list: () => new Promise((done) => (resolve = done)),
    })

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    resolve({ data: ["root"] })
    expect(await pending).toEqual(["root"])
  })

  test("falls back when the root request returns an error response", async () => {
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({}) })).toBeUndefined()
  })

  test("falls back when the root request rejects", async () => {
    expect(
      await loadDialogSessionList({
        filter: {},
        list: () => Promise.reject(new Error("offline")),
      }),
    ).toBeUndefined()
  })

  test("row footer shows the directory and per-session spend", () => {
    expect(sessionRowFooter({ directory: "api-gateway", cost: 1.23 })).toBe("api-gateway · $1.23")
  })

  test("row footer shows spend alone when there is no directory", () => {
    expect(sessionRowFooter({ directory: undefined, cost: 4.5 })).toBe("$4.50")
  })

  test("row footer keeps zero and missing spend visible", () => {
    expect(sessionRowFooter({ directory: "api-gateway", cost: 0 })).toBe("api-gateway · $0.00")
    expect(sessionRowFooter({ directory: undefined, cost: undefined })).toBe("$0.00")
  })

  test("row footer formats spend as en-US USD", () => {
    expect(sessionRowFooter({ directory: undefined, cost: 1234.5 })).toBe("$1,234.50")
  })
})
