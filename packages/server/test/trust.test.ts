import { expect, test } from "bun:test"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { standardReplacements } from "../src/routes"

// The operator's trust declaration is host data: it arrives in ServerOptions and must reach
// ProjectTrust.Service through the same replacement list createRoutes installs, because that is
// what trust-aware consumers (InstructionDiscovery, and the read tool) resolve. An omitted
// declaration must stay closed. Compiling the standard replacements over ProjectTrust.node alone
// exercises the real wiring without booting a server.
type TrustInput = { readonly trust?: { readonly all: boolean; readonly roots: string[] } }

const service = (config?: TrustInput) =>
  Effect.gen(function* () {
    return yield* ProjectTrust.Service
  }).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([ProjectTrust.node]), {
        replacements: standardReplacements({ config }),
      }),
    ),
  )

test("a declared root reaches ProjectTrust through the standard server replacements", async () => {
  const trust = await Effect.runPromise(service({ trust: { all: false, roots: ["/declared/root"] } }))

  expect(trust.data).toEqual({ all: false, roots: ["/declared/root"] })
  expect(trust.allows("/declared/root/nested")).toBe(true)
  expect(trust.allows("/declared/elsewhere")).toBe(false)
})

test("an absent declaration stays closed", async () => {
  const trust = await Effect.runPromise(service())

  expect(trust.data).toEqual({ all: false, roots: [] })
  expect(trust.allows("/declared/root")).toBe(false)
})

test("all: true keeps the historical unbounded behavior", async () => {
  const trust = await Effect.runPromise(service({ trust: { all: true, roots: [] } }))

  expect(trust.allows("/anywhere")).toBe(true)
})
