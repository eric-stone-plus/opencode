import type { CliRenderer } from "@opentui/core"

// A fixed 60 fps budget keeps the render loop hot for as long as any animation holds it live,
// which is how an idle terminal burned a core. Rendering is rationed to what the screen needs:
// a trickle while nothing runs, a moderate rate while a session streams.
export const IDLE_FPS = 8
export const BUSY_FPS = 30

export function applyRenderBudget(renderer: Pick<CliRenderer, "targetFps" | "maxFps">, busy: boolean) {
  const fps = busy ? BUSY_FPS : IDLE_FPS
  if (renderer.targetFps === fps && renderer.maxFps === fps) return
  // targetFps paces the continuous loop; maxFps bounds how soon a requested render may follow the last frame.
  renderer.targetFps = fps
  renderer.maxFps = fps
}
