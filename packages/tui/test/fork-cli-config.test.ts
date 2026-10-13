import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Info, resolve } from "../src/config"

// The fork ships cli.json at the repository root and the install step copies it to ~/.config/opencode/cli.json.
// tui.json is migrated into cli.json only once, so this file is the only way the keybind and session-presentation
// policy reaches a client that has already launched V2. Resolving it here catches an upstream rename of any
// keybind or session setting it names.
const shipped = await Bun.file(new URL("../../../cli.json", import.meta.url)).json()
const info = Object.fromEntries(Object.entries(shipped).filter(([key]) => key !== "$schema"))
const config = resolve(Schema.decodeUnknownSync(Info)(info), { terminalSuspend: true })

const keys = (command: string) => config.keybinds.get(command).flatMap((binding) => String(binding.key).split(","))

test("Ctrl+C, Ctrl+D and the leader shortcut no longer exit; /exit still does", () => {
  expect(config.keybinds.get("app.exit")).toEqual([])
})

test("pages with ctrl and alt arrows and scrolls lines with ctrl+shift arrows", () => {
  expect(keys("session.page.up")).toEqual(["pageup", "ctrl+up", "alt+up", "ctrl+alt+b"])
  expect(keys("session.page.down")).toEqual(["pagedown", "ctrl+down", "alt+down", "ctrl+alt+f"])
  expect(keys("session.line.up")).toEqual(["ctrl+alt+y", "ctrl+shift+up"])
  expect(keys("session.line.down")).toEqual(["ctrl+alt+e", "ctrl+shift+down"])
})

test("bare arrows stay with the prompt cursor and history", () => {
  const scrolling = ["session.page.up", "session.page.down", "session.line.up", "session.line.down"].flatMap(keys)
  expect(scrolling.filter((key) => ["up", "down", "left", "right"].includes(key))).toEqual([])
})

test("Tab cycles agents forward and shift+tab backward (V1 policy restored)", () => {
  expect(keys("agent.cycle")).toEqual(["tab"])
  expect(keys("agent.cycle.reverse")).toEqual(["shift+tab"])
})

test("thinking blocks are shown by default", () => {
  expect(config.session?.thinking).toBe("show")
})

test("keeps the mouse on", () => {
  expect(config.mouse).toBe(true)
})
