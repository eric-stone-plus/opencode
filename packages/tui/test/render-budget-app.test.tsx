import { test } from "bun:test"
import { BUSY_FPS, IDLE_FPS } from "../src/util/render-budget"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

const durable = (seq: number) => ({ aggregateID: "ses_budget", seq, version: 1 as const })

test("the app renders at the idle budget until a session runs", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({ state: state.path })
  await setup.ready
  await setup.waitFor(() => setup.renderer.targetFps === IDLE_FPS && setup.renderer.maxFps === IDLE_FPS)

  setup.events.emit({
    id: "evt_budget_started",
    created: 1,
    type: "session.execution.started",
    durable: durable(1),
    data: { sessionID: "ses_budget" },
  })
  await setup.waitFor(() => setup.renderer.targetFps === BUSY_FPS && setup.renderer.maxFps === BUSY_FPS)

  setup.events.emit({
    id: "evt_budget_succeeded",
    created: 2,
    type: "session.execution.succeeded",
    durable: durable(2),
    data: { sessionID: "ses_budget" },
  })
  await setup.waitFor(() => setup.renderer.targetFps === IDLE_FPS && setup.renderer.maxFps === IDLE_FPS)
})
