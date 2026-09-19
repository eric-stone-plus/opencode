import { expect, test } from "bun:test"
import { applyRenderBudget, requestAnimationBudget, IDLE_FPS, BUSY_FPS } from "../../src/util/render-budget"

test("closing an animation restores the current session budget after the run finishes", () => {
  const renderer = { targetFps: IDLE_FPS, maxFps: IDLE_FPS }
  applyRenderBudget(renderer, true)
  const release = requestAnimationBudget(renderer)
  applyRenderBudget(renderer, false)
  expect(renderer).toEqual({ targetFps: BUSY_FPS, maxFps: BUSY_FPS })
  release()
  expect(renderer).toEqual({ targetFps: IDLE_FPS, maxFps: IDLE_FPS })
})

test("releasing an animation keeps the busy budget if a run started while it was open", () => {
  const renderer = { targetFps: IDLE_FPS, maxFps: IDLE_FPS }
  const release = requestAnimationBudget(renderer)
  applyRenderBudget(renderer, true)
  release()
  expect(renderer).toEqual({ targetFps: BUSY_FPS, maxFps: BUSY_FPS })
})

test("overlapping animations retain their budget until each one is released", () => {
  const renderer = { targetFps: IDLE_FPS, maxFps: IDLE_FPS }
  const first = requestAnimationBudget(renderer)
  const second = requestAnimationBudget(renderer)
  first()
  first()
  expect(renderer).toEqual({ targetFps: BUSY_FPS, maxFps: BUSY_FPS })
  second()
  expect(renderer).toEqual({ targetFps: IDLE_FPS, maxFps: IDLE_FPS })
})
