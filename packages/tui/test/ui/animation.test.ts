import { afterEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { animating, createAnimatable, tween } from "../../src/ui/animation"

const disposals: Array<() => void> = []

afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("the render budget sees a transition while it runs and not after it settles", async () => {
  expect(animating()).toBe(false)
  const motion = createRoot((dispose) => {
    disposals.push(dispose)
    return createAnimatable({ level: 0 }, { transition: tween({ duration: 0.05 }) })
  })
  expect(animating()).toBe(false)
  motion.animate({ level: 1 })
  expect(animating()).toBe(true)
  await wait(200)
  expect(motion.value().level).toBe(1)
  expect(animating()).toBe(false)
})

test("disposing an owner stops its in-flight transition", () => {
  const dispose = createRoot((dispose) => {
    createAnimatable({ level: 0 }, { transition: tween({ duration: 5 }) }).animate({ level: 1 })
    return dispose
  })
  expect(animating()).toBe(true)
  dispose()
  expect(animating()).toBe(false)
})
