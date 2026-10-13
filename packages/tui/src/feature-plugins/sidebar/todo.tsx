import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

export function SidebarTodo(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const list = createMemo(() => props.context.data.session.todo.list(props.sessionID) ?? [])
  // Same rule as the V1 panel: nothing worth showing while every task is done.
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))

  return (
    <Show when={show()}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (list().length <= 2) return
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist todo sidebar state", error))
          }}
        >
          <Show when={list().length > 2}>
            <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.base}>
            <b>Todo</b>
          </text>
        </box>
        <Show when={list().length <= 2 || view.open}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={0}>
                <text
                  flexShrink={0}
                  style={{
                    fg: item.status === "in_progress" ? theme.text.feedback.warning.base : theme.text.muted,
                  }}
                >
                  [{item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : " "}]{" "}
                </text>
                <text
                  flexGrow={1}
                  wrapMode="word"
                  style={{
                    fg: item.status === "in_progress" ? theme.text.feedback.warning.base : theme.text.muted,
                  }}
                >
                  {item.content}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.todo",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarTodo context={context} sessionID={props.sessionID} />,
    })
  },
})
