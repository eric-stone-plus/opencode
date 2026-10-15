import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

type Status = { id: string; name: string; status: "connected" | "error" }

// A row is a snapshot of the last status the runtime reported, and this panel is event-driven:
// nothing re-confirms a row whose state has not changed. Remembering when each server entered its
// current state lets an unhealthy row say how long it has been that way, which is the difference
// between a fresh failure and one that has been stuck long enough to be worth retrying.
export const LSP_STALE_AFTER_MS = 5 * 60 * 1000

export function createStatusAges(now: () => number = Date.now) {
  const seen = new Map<string, { status: Status["status"]; at: number }>()
  return (rows: readonly Status[], at = now()) => {
    const ages = new Map<string, number>()
    for (const row of rows) {
      const entry = seen.get(row.id)
      if (!entry || entry.status !== row.status) {
        seen.set(row.id, { status: row.status, at })
        ages.set(row.id, 0)
        continue
      }
      ages.set(row.id, at - entry.at)
    }
    return ages
  }
}

export function staleLabel(status: Status["status"], ageMs: number) {
  if (status === "connected") return undefined
  if (ageMs < LSP_STALE_AFTER_MS) return undefined
  return `stale ${Math.floor(ageMs / 60_000)}m`
}

// The runtime runs one client per (server, root), so a server that matched two roots is reported once
// per root. The sidebar lists servers: collapse to one row per server, and let an unhealthy row win so
// the dot never hides a server that needs attention.
const byServer = (rows: readonly Status[]) => [
  ...rows
    .reduce((servers, row) => {
      const existing = servers.get(row.id)

      if (!existing || (existing.status === "connected" && row.status !== "connected")) servers.set(row.id, row)
      return servers
    }, new Map<string, Status>())
    .values(),
]

// Starting a client for a root already covered by a listed server changes nothing the sidebar shows.
// Keeping the previous rows then leaves the list untouched instead of rebuilding it per spawn.
const sameServers = (previous: readonly Status[] = [], next: readonly Status[] = []) =>
  previous.length === next.length &&
  previous.every((row, index) => row.id === next[index].id && row.status === next[index].status)

export function SidebarLsp(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(
    () => byServer(props.context.data.location.lspStatus.list(session()?.location) ?? []),
    undefined,
    { equals: sameServers },
  )

  const ageOf = createStatusAges()
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 30_000)
  onCleanup(() => clearInterval(timer))
  const ages = createMemo(() => {
    tick()
    return ageOf(list(), Date.now())
  })

  return (
    <box>
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => {
          if (list().length <= 2) return
          void updateView((draft) => {
            draft.open = !draft.open
          }).catch((error) => console.error("Failed to persist LSP sidebar state", error))
        }}
      >
        <Show when={list().length > 2}>
          <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme.text.base}>
          <b>LSP</b>
        </text>
      </box>
      <Show when={list().length <= 2 || view.open}>
        <Show when={list().length === 0}>
          <text fg={theme.text.muted}>LSPs will activate as files are read</text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1} minWidth={0}>
              <text
                flexShrink={0}
                style={{
                  fg: item.status === "connected" ? theme.text.feedback.success.base : theme.text.feedback.error.base,
                }}
              >
                •
              </text>
              {/* The server name alone: root paths are noise on a sidebar this narrow, and `byServer`
                  has already collapsed the roots of one server into this row. */}
              <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                <b>{item.name}</b>
                <Show when={staleLabel(item.status, ages().get(item.id) ?? 0)}>
                  <span style={{ fg: theme.text.muted }}>{" " + staleLabel(item.status, ages().get(item.id) ?? 0)}</span>
                </Show>
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.lsp",
  setup(context) {
    // Append keeps the path open to additive plugin claims; an external
    // replace still takes the boundary over.
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarLsp context={context} sessionID={props.sessionID} />,
    })
  },
})
