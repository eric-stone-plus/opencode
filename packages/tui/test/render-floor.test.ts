import { expect, test } from "bun:test"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

// Records every delay the render loop asks of the clock. The clock never advances, so the loop runs exactly once.
async function firstFrameDelays(input: { fps: number; frameMs: number }) {
  const clock = new ManualClock()
  const delays: number[] = []
  const schedule = clock.setTimeout.bind(clock)
  clock.setTimeout = (callback, delay) => {
    delays.push(delay)
    return schedule(callback, delay)
  }
  const setup = await createTestRenderer({
    width: 20,
    height: 4,
    useThread: false,
    clock,
    targetFps: input.fps,
    maxFps: input.fps,
  })
  try {
    setup.renderer.setFrameCallback(async () => {
      // overallFrameTime is measured with performance.now(), so an overrun has to be real time
      const end = performance.now() + input.frameMs
      while (performance.now() < end);
    })
    setup.renderer.start()
    await Bun.sleep(input.frameMs + 100)
    return delays
  } finally {
    setup.renderer.destroy()
  }
}

// patches/@opentui%2Fcore@0.5.17.patch floors the delay between frames at 16 ms. Without it a frame that overruns
// its budget re-arms a 1 ms timer and the render loop runs flat out.
test("a frame that overruns its budget still leaves at least 16 ms before the next one", async () => {
  const delays = await firstFrameDelays({ fps: 30, frameMs: 45 })
  expect(delays.length).toBeGreaterThan(0)
  expect(Math.min(...delays)).toBeGreaterThanOrEqual(16)
})

test("a fast frame still waits out the rest of its budget", async () => {
  const delays = await firstFrameDelays({ fps: 8, frameMs: 0 })
  expect(delays.length).toBeGreaterThan(0)
  expect(Math.min(...delays)).toBeGreaterThan(100)
})
