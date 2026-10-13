import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_clear",
  title: "Session to clear",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function render(state: string) {
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
        })
    },
  })
}

// The session route shows the prompt but no home wordmark; home shows the wordmark.
const onSessionScreen = (frame: string) => frame.includes("Build · Model Provider") && !frame.includes("█▀▀█")
const onHomeScreen = (frame: string) => frame.includes("█▀▀█ █▀▀█")

test("/clear leaves the session for the home screen", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)

  await setup.waitForFrame(onSessionScreen)
  await setup.mockInput.typeText("/clear")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame(onHomeScreen)

  expect(frame).not.toContain("Session to clear")
})

test("/new opens the home screen and leaves the session behind it", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)

  await setup.waitForFrame(onSessionScreen)
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame(onHomeScreen)

  // The session is no longer on screen anywhere — with tabs gone, home is the only surface.
  expect(frame).not.toContain("Session to clear")
})
