// Fail-closed permission guard (borrow C21). The guard is registered last on the permission hook
// chain, so it observes whatever effect the preceding hooks left on the shared event. These tests pin
// both halves: the pure decision (an unknown effect and a failed derivation deny; a decision is never
// loosened and an existing deny keeps its attribution) and the hook wiring that applies it.
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { ForkGuardPlugin, guardDecision } from "@opencode/core/plugin/fork/guard"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { testEffect } from "../../lib/effect"
import { host } from "../host"

const session = SessionSchema.ID.make("ses_guard")

describe("guardDecision", () => {
  test("an unknown effect denies: a runtime-loaded plugin can assign a value the types never saw", () => {
    expect(guardDecision("ALLOW" as never, undefined, undefined)).toEqual({
      effect: "deny",
      message: `permission guard: unknown effect "ALLOW"`,
    })
  })

  test("a failed derivation denies instead of leaving the decision alone", () => {
    expect(guardDecision("allow", undefined, "derivation timed out")).toEqual({
      effect: "deny",
      message: "permission guard: derivation timed out",
    })
  })

  test("an existing deny keeps its attribution", () => {
    const message = `denied by parent session ${session}: edit /etc/passwd`
    expect(guardDecision("deny", message, undefined)).toEqual({ effect: "deny", message })
  })

  test("a healthy decision passes through unchanged, including ask", () => {
    expect(guardDecision("ask", "approval required", undefined)).toEqual({ effect: "ask", message: "approval required" })
    expect(guardDecision("allow", undefined, undefined)).toEqual({ effect: "allow" })
  })
})

const it = testEffect(Layer.empty)

type Get = (request: { sessionID: SessionSchema.ID }) => Effect.Effect<SessionSchema.Info, unknown>

/** Runs the plugin against a stubbed session store and captures its evaluate hook. */
const run = Effect.fnUntraced(function* (get: Get) {
  let evaluateHook: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  yield* ForkGuardPlugin.Plugin.effect(
    host({
      permission: {
        hook: (name, callback) => {
          if (name === "evaluate") evaluateHook = callback as (event: PermissionEvaluation) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        list: () => Effect.die("unused permission.list"),
        get: () => Effect.die("unused permission.get"),
        reply: () => Effect.die("unused permission.reply"),
        assert: () => Effect.die("unused permission.assert"),
      },
      session: { get },
    }),
  )
  if (!evaluateHook) return yield* Effect.die("fork.permission-guard did not register an evaluate hook")
  return evaluateHook
})

const evaluate = (effect: PermissionEvaluation["effect"], message?: string): PermissionEvaluation => ({
  sessionID: session,
  action: "edit",
  resources: ["/etc/passwd"],
  effect,
  ...(message === undefined ? {} : { message }),
})

const live = () =>
  Effect.succeed(
    SessionSchema.Info.make({
      id: session,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: { directory: AbsolutePath.make("/workspace") },
      permissions: [],
    }),
  )

describe("fork permission guard: the hook", () => {
  it.effect("denies an effect value that is not one of the three declared ones", () =>
    Effect.gen(function* () {
      const hook = yield* run(live)
      const event = evaluate("ALLOW" as never)
      yield* hook(event)
      expect(event.effect).toBe("deny")
      expect(event.message).toBe(`permission guard: unknown effect "ALLOW"`)
    }),
  )

  it.effect("denies when its derivation cannot read the session, instead of failing the evaluation", () =>
    Effect.gen(function* () {
      const hook = yield* run(() => Effect.fail("no session"))
      const event = evaluate("allow")
      yield* hook(event)
      expect(event.effect).toBe("deny")
      expect(event.message).toStartWith("permission guard: derivation failed:")
    }),
  )

  it.effect("denies when the derivation wedges: the timeout keeps a tool call from stalling", () =>
    Effect.gen(function* () {
      const hook = yield* run(() => Effect.never)
      const event = evaluate("allow")
      const fiber = yield* Effect.forkChild(hook(event))
      yield* TestClock.adjust("6 seconds")
      yield* Fiber.join(fiber)
      expect(event.effect).toBe("deny")
      expect(event.message).toBe("permission guard: derivation timed out")
    }),
  )

  it.effect("leaves a healthy decision alone", () =>
    Effect.gen(function* () {
      const hook = yield* run(live)
      const event = evaluate("ask")
      yield* hook(event)
      expect(event.effect).toBe("ask")
      expect(event.message).toBeUndefined()
    }),
  )

  it.effect("keeps the message a preceding hook wrote on a deny", () =>
    Effect.gen(function* () {
      const hook = yield* run(live)
      const event = evaluate("deny", `denied by parent session ${session}: edit /etc/passwd`)
      yield* hook(event)
      expect(event.effect).toBe("deny")
      expect(event.message).toBe(`denied by parent session ${session}: edit /etc/passwd`)
    }),
  )
})
