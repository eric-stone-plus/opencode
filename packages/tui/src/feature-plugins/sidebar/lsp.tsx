import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

type Status = { id: string; name: string; status: "connected" | "error" }

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
