import { expect, test } from "bun:test"
import { clampSessionPaneWidth, SESSION_SIDEBAR_WIDTH } from "../../src/ui/layout"

test("the sidebar keeps its fixed width", () => {
  expect(SESSION_SIDEBAR_WIDTH).toBe(42)
})

test("pane width preserves the equal split and the content minimum", () => {
  // Pane values clamp between half the terminal (at most 24) and the content floor.
  expect(clampSessionPaneWidth(0, 120)).toBe(24)
  expect(clampSessionPaneWidth(30, 120)).toBe(30)
  expect(clampSessionPaneWidth(200, 120)).toBe(76)
  expect(clampSessionPaneWidth(10, 40)).toBe(20)
})
