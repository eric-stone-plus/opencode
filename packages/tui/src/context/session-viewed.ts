import { createEffect, createSignal, onCleanup } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { useClient } from "./client"
import type { useData } from "./data"
import type { useRoute } from "./route"

// A refused acknowledgement retries with backoff; a client can be offline at the moment
// the user lands on a session and the watermark must still reach the server eventually.
const VIEW_RETRY_DELAY = 250
const VIEW_RETRY_MAX_DELAY = 5_000

/**
 * Reports the focused session as viewed once its idle watermark is newer than the last
 * acknowledged one. Viewed state is server-global — other clients and the app rely on this
 * TUI telling the server what its user has actually seen — so this runs regardless of which
 * session surfaces this client shows. It used to live inside the session-tabs context; the
 * tab strip is gone, the acknowledgement contract is not.
 */
export function createSessionViewed(input: {
  renderer: ReturnType<typeof useRenderer>
  client: ReturnType<typeof useClient>
  data: ReturnType<typeof useData>
  route: ReturnType<typeof useRoute>
}) {
  const [focused, setFocused] = createSignal<boolean>()
  const onFocus = () => setFocused(true)
  const onBlur = () => setFocused(false)
  useKeyboard(onFocus)
  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)
  onCleanup(() => {
    input.renderer.off("focus", onFocus)
    input.renderer.off("blur", onBlur)
  })

  const acknowledged = new Map<string, number>()
  const [viewRetry, setViewRetry] = createSignal(0)
  let viewRetryTimer: ReturnType<typeof setTimeout> | undefined
  let viewRetryAttempt = 0
  onCleanup(() => clearTimeout(viewRetryTimer))
  createEffect(() => {
    viewRetry()
    if (focused() !== true) return
    const route = input.route.data
    if (route.type !== "session" || route.sessionID === "dummy") return
    const sessionID = input.data.session.root(route.sessionID)
    const info = input.data.session.get(sessionID)
    if (!info || info.time.idle === undefined) return
    const idle = info.time.idle
    const unread = info.time.viewed === undefined || idle > info.time.viewed
    if (!unread || acknowledged.get(sessionID) === idle) return
    // Record before the request so event-driven re-runs don't re-post the same watermark.
    acknowledged.set(sessionID, idle)
    void input.client.api.session.view({ sessionID, idle }).then(
      () => {
        clearTimeout(viewRetryTimer)
        viewRetryTimer = undefined
        viewRetryAttempt = 0
      },
      () => {
        if (acknowledged.get(sessionID) !== idle) return
        acknowledged.delete(sessionID)
        if (viewRetryTimer) return
        const delay = Math.min(VIEW_RETRY_DELAY * 2 ** viewRetryAttempt, VIEW_RETRY_MAX_DELAY)
        viewRetryAttempt++
        viewRetryTimer = setTimeout(() => {
          viewRetryTimer = undefined
          setViewRetry((value) => value + 1)
        }, delay)
      },
    )
  })
}
