/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { PermissionProvider, usePermission } from "../src/context/permission"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

// The TUI is auto-accept-only on purpose: a permission request must be answered
// by the client itself, with no prompt and no input. These two tests pin both
// halves — the mode the UI reads, and the reply the server actually receives.

test("reports the permission mode as auto-accept", async () => {
  let mode: string | undefined

  function Probe() {
    mode = usePermission().mode
    return <box />
  }

  const app = await testRender(() => (
    <PermissionProvider>
      <Probe />
    </PermissionProvider>
  ))
  try {
    await app.renderOnce()
    expect(mode).toBe("autoaccept")
  } finally {
    app.renderer.destroy()
  }
})

test("auto-accepts a pending permission request without any input", async () => {
  const replies: Array<{ path: string; body: unknown }> = []
  const directory = "/tmp/opencode/packages/tui"
  const session = {
    id: "ses_autoaccept",
    title: "Auto-accept fixture",
    projectID: "proj_fixture",
    location: { directory },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }

  await using setup = await createAppFixture({
    width: 140,
    height: 20,
    config: { animations: false },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/ses_autoaccept\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname.endsWith("/reply")) {
        replies.push({ path: url.pathname, body: await request.json() })
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })

  // The session route owns the auto-accept effect, so wait until it is mounted.
  await setup.waitForFrame((frame) => frame.includes(session.title), { maxPasses: 60 })

  setup.events.emit({
    id: "evt_permission_asked",
    created: 0,
    type: "permission.asked",
    data: { id: "per_autoaccept", sessionID: session.id, action: "shell", resources: ["bun test"] },
  })

  await setup.waitFor(() => replies.length === 1)
  expect(replies[0]?.path).toBe(`/api/session/${session.id}/permission/per_autoaccept/reply`)
  expect(replies[0]?.body).toEqual({ decision: "once" })

  // And the request never turns into a question for the user.
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain("Permission required")
  expect(frame).not.toContain("bun test")
})

test("keeps waiting while the reply is rejected, instead of asking the user", async () => {
  // The prompt path is gone on purpose, so the reply attempt is the only way a
  // pending request is ever answered. This pins that the client keeps the
  // request actionable (a later event retries) rather than surfacing a prompt.
  const replies: string[] = []
  const directory = "/tmp/opencode/packages/tui"
  const session = {
    id: "ses_autoaccept_fail",
    title: "Auto-accept failure fixture",
    projectID: "proj_fixture",
    location: { directory },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }

  await using setup = await createAppFixture({
    width: 140,
    height: 20,
    config: { animations: false },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/ses_autoaccept_fail\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname.endsWith("/reply")) {
        await request.json()
        replies.push(url.pathname)
        return new Response("nope", { status: 500 })
      }
      return undefined
    },
  })

  await setup.waitForFrame((frame) => frame.includes(session.title), { maxPasses: 60 })

  setup.events.emit({
    id: "evt_permission_asked_fail",
    created: 0,
    type: "permission.asked",
    data: { id: "per_failing", sessionID: session.id, action: "shell", resources: ["bun test"] },
  })

  await setup.waitFor(() => replies.length === 1)
  await setup.renderOnce()
  // A rejected reply leaves the request pending and toasts (routes/session/index.tsx:274-277);
  // recovery is another event or a route remount. What must never happen is falling back to asking.
  expect(setup.captureCharFrame()).not.toContain("Permission required")
})
