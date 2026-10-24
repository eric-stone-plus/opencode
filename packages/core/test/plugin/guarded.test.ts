import { describe, expect, test } from "bun:test"
import { ForkPlugin } from "../../src/plugin/fork/index"
import { PluginInternal } from "../../src/plugin/internal"

// Repository config is untrusted: a repository the seat opens can carry
// `plugins: ["-*"]` or `"-<id>"` removals. The guarded set is what stops a
// repository from switching off the fork's own behavior chain or the seat's
// safety guards, so these tests pin the set's coverage rather than its exact
// membership.
describe("guarded plugin ids", () => {
  test("every fork plugin survives repository removals", () => {
    for (const plugin of [...ForkPlugin.pre, ...ForkPlugin.post]) expect(PluginInternal.guarded.has(plugin.id)).toBe(true)
    expect(PluginInternal.guarded.has("opencode.fork.runtime")).toBe(true)
    expect(PluginInternal.guarded.has("opencode.config.agent")).toBe(true)
  })

  test("the seat's external safety guards survive repository removals", () => {
    expect(PluginInternal.guarded.has("block-unsafe-kill")).toBe(true)
    expect(PluginInternal.guarded.has("secret-path-guard")).toBe(true)
  })

  test("policy plugins survive repository removals", () => {
    expect(PluginInternal.guarded.has("opencode.config.policy")).toBe(true)
    expect(PluginInternal.guarded.has("fork.declared-providers")).toBe(true)
  })
})
