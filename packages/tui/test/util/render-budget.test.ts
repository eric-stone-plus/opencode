import { expect, test } from "bun:test"
import { applyRenderBudget, BUSY_FPS, IDLE_FPS } from "../../src/util/render-budget"

test("idle sessions render at the idle budget and running sessions at the busy budget", () => {
  const renderer = { targetFps: 60, maxFps: 60 }
  applyRenderBudget(renderer, false)
  expect(renderer).toEqual({ targetFps: IDLE_FPS, maxFps: IDLE_FPS })
  applyRenderBudget(renderer, true)
  expect(renderer).toEqual({ targetFps: BUSY_FPS, maxFps: BUSY_FPS })
  applyRenderBudget(renderer, false)
  expect(renderer).toEqual({ targetFps: IDLE_FPS, maxFps: IDLE_FPS })
})

test("the idle budget is lower than the busy budget", () => {
  expect(IDLE_FPS).toBeLessThan(BUSY_FPS)
  expect(IDLE_FPS).toBe(8)
  expect(BUSY_FPS).toBe(30)
})

test("a renderer already on the budget is not written again", () => {
  const writes: string[] = []
  let targetFps = IDLE_FPS
  let maxFps = IDLE_FPS
  const renderer = {
    get targetFps() {
      return targetFps
    },
    set targetFps(value: number) {
      writes.push(`target:${value}`)
      targetFps = value
    },
    get maxFps() {
      return maxFps
    },
    set maxFps(value: number) {
      writes.push(`max:${value}`)
      maxFps = value
    },
  }
  applyRenderBudget(renderer, false)
  expect(writes).toEqual([])
  applyRenderBudget(renderer, true)
  expect(writes).toEqual([`target:${BUSY_FPS}`, `max:${BUSY_FPS}`])
})
