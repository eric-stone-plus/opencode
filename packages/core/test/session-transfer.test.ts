import { expect, test } from "bun:test"
import { sanitizeImportedInfo } from "@opencode/core/session/transfer"

test("imported session rules may restrict but never grant", () => {
  const imported = sanitizeImportedInfo({
    permissions: [
      { effect: "allow", action: "*", resource: "*" },
      { effect: "deny", action: "edit", resource: "*" },
      { effect: "ask", action: "bash", resource: "*" },
    ],
  })
  expect(imported.permissions?.map((rule) => rule.effect)).toEqual(["deny", "ask"])
})

test("imported titles arrive plain and bounded", () => {
  const imported = sanitizeImportedInfo({ title: "shared\x1b]52;c;Y3VybCB8c2g=\x07" + "x".repeat(500) })
  expect(imported.title).not.toContain("\x1b")
  expect(imported.title).not.toContain("\x07")
  expect(imported.title?.length).toBe(200)
  expect(sanitizeImportedInfo({}).title).toBeUndefined()
})
