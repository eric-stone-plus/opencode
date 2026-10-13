/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarTodo } from "../../src/feature-plugins/sidebar/todo"

type Todo = { content: string; status: string; priority: string }

function context(options?: { todos?: Array<Todo> }) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { warning: { base: color } },
      },
    },
    storage: { store: () => [{ open: true }, async () => {}] },
    data: {
      session: { todo: { list: () => options?.todos ?? [] } },
    },
  } as unknown as Context
}

test("sidebar hides while the list is empty or fully completed", async () => {
  const idle = await testRender(() => <SidebarTodo context={context()} sessionID="session" />, {
    width: 42,
    height: 8,
  })
  try {
    await idle.renderOnce()
    expect(idle.captureCharFrame()).not.toContain("Todo")
  } finally {
    idle.renderer.destroy()
  }

  const done = await testRender(
    () => (
      <SidebarTodo
        context={context({ todos: [{ content: "old chore", status: "completed", priority: "low" }] })}
        sessionID="session"
      />
    ),
    { width: 42, height: 8 },
  )
  try {
    await done.renderOnce()
    expect(done.captureCharFrame()).not.toContain("Todo")
  } finally {
    done.renderer.destroy()
  }
})

test("sidebar lists todos with their status prefixes", async () => {
  const app = await testRender(
    () => (
      <SidebarTodo
        context={context({
          todos: [
            { content: "wire the panel", status: "in_progress", priority: "high" },
            { content: "call the endpoint", status: "pending", priority: "medium" },
            { content: "old chore", status: "completed", priority: "low" },
          ],
        })}
        sessionID="session"
      />
    ),
    { width: 42, height: 10 },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Todo")
    expect(frame).toContain("[•] wire the panel")
    expect(frame).toContain("[ ] call the endpoint")
    expect(frame).toContain("[✓] old chore")
  } finally {
    app.renderer.destroy()
  }
})
