/**
 * Shared easing math for chrome animations. Extracted verbatim from the removed
 * session-tab strip (`component/tab-pulse.tsx`) because the text animations —
 * fade-in-text, retry-provider, shimmer-text, title-shimmer — depend on it.
 */

export const clamp = (value: number) => Math.max(0, Math.min(1, value))

export const smootherstep = (value: number) => value * value * value * (value * (value * 6 - 15) + 10)

/** A travelling sweep: ramps up over `head` cells ahead of `front`, decays over `tail` behind it. */
export const intensityAt = (index: number, front: number, head: number, tail: number) => {
  const distance = front - index
  return distance < 0 ? smootherstep(clamp(1 + distance / head)) : smootherstep(clamp(1 - distance / tail))
}

/** Ease in and out with a linear middle: the resting-to-active ramp used by chrome shimmer. */
export const coast = (value: number) => {
  const ramp = 0.2
  if (value < ramp) return (value * value) / (2 * ramp * (1 - ramp))
  if (value > 1 - ramp) return 1 - ((1 - value) * (1 - value)) / (2 * ramp * (1 - ramp))
  return (value - ramp / 2) / (1 - ramp)
}
