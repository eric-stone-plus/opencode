/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { DialogSelectOption } from "../../../src/ui/dialog-select"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { goldenFrames } from "../../util/golden"

// The filter input is left out on purpose: its cursor blinks on a timer, which would make the frame
// depend on when the snapshot ran rather than on the layout the contract is about.
async function harness(root: string, options: DialogSelectOption<string>[]) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [
    { ConfigProvider },
    { ThemeProvider },
    { Keymap },
    { DialogProvider },
    { DialogSelect },
    { ToastProvider },
  ] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/ui/toast"),
  ])

  return () => (
    <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
      <ConfigProvider config={config}>
        <Keymap.Provider>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <ToastProvider>
              <DialogProvider>
                <DialogSelect
                  title="Pick a model"
                  options={options}
                  renderFilter={false}
                  footerHints={[{ title: "Choose", label: "enter", side: "right" }]}
                />
              </DialogProvider>
            </ToastProvider>
          </ThemeProvider>
        </Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  )
}

test("golden: a dialog row that is unavailable explains itself", async () => {
  await using tmp = await tmpdir()
  const component = await harness(tmp.path, [
    { title: "deepseek-chat", value: "deepseek-chat", description: "ready" },
    { title: "deepseek-reasoner", value: "deepseek-reasoner", disabled: true, reason: "no API key" },
    { title: "qwen3.8-max", value: "qwen3.8-max" },
    { title: "internal-only", value: "internal-only", disabled: true },
  ])

  expect(await goldenFrames(component)).toMatchSnapshot()
})
