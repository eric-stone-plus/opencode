import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

export function SidebarLsp(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.lspStatus.list(session()?.location) ?? [])

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
              {/* The server name alone: names are the readable unit ("gopls", "typescript"),
                  and the root path added noise without disambiguating anything a single
                  working directory can hold twice. */}
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
