// Contract for the CURRENT precedence semantics: `Permission.evaluate` scans with `findLast`, so the last
// matching rule in load order wins - a later config document can re-allow what an earlier one denied.
// This pins today's behavior, NOT a deny guarantee. See PERSONAL.md "Project config trust gate"; a failure
// here means a deliberate decision about the ordering is due, not a flake to silence.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Document, Info } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const deny = [{ action: "edit", resource: "*", effect: "deny" }] satisfies Permission.Ruleset
const allow = [{ action: "edit", resource: "*", effect: "allow" }] satisfies Permission.Ruleset
const at = { action: "edit", resource: "src/index.ts" }

describe("permission rules (pinned current semantics)", () => {
  test("the last matching rule wins in both directions, and no match asks", () => {
    expect(Permission.evaluate(at.action, at.resource, deny, allow).effect).toBe("allow")
    expect(Permission.evaluate(at.action, at.resource, allow, deny).effect).toBe("deny")
    expect(Permission.evaluate(at.action, at.resource, []).effect).toBe("ask")
  })

  test("merge is flat and keeps the order of its arguments", () => {
    expect(Permission.merge(deny, allow)).toEqual([...deny, ...allow])
    expect(Permission.evaluate(at.action, at.resource, Permission.merge(deny, allow)).effect).toBe("allow")
  })
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Info)

// Positions stand in for loader order (config.ts:230-237 - wellknown, global, explicit, direct, project,
// content): the first document loads first, the second last, so the second one is the project document.
const documents = (first: "allow" | "deny", second: "allow" | "deny") => [
  new Document({
    type: "document",
    info: decode({ permissions: first === "allow" ? allow : deny, agents: { build: { permissions: first === "allow" ? allow : deny } } }),
  }),
  new Document({
    type: "document",
    info: decode({ permissions: second === "allow" ? allow : deny, agents: { build: { permissions: second === "allow" ? allow : deny } } }),
  }),
]

const loaded = (entries: readonly Document[]) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer([...entries])),
    )
    const build = yield* agents.get(Agent.ID.make("build"))
    if (!build) throw new Error("expected the build agent")
    return build.permissions
  })

describe("config document order (pinned: later documents win)", () => {
  it.effect("a later document's allow is effective over an earlier deny", () =>
    Effect.gen(function* () {
      const permissions = yield* loaded(documents("deny", "allow"))
      expect(Permission.evaluate(at.action, at.resource, permissions).effect).toBe("allow")
    }),
  )

  it.effect("swapping the order flips the outcome", () =>
    Effect.gen(function* () {
      const permissions = yield* loaded(documents("allow", "deny"))
      expect(Permission.evaluate(at.action, at.resource, permissions).effect).toBe("deny")
    }),
  )
})

const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") })))
const itPermission = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

const sessionID = Session.ID.make("ses_precedence")

const setup = (rules: Permission.Ruleset = []) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "test", directory: "/project", title: "test", version: "test", agent: "build" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })

const setRules = (rules: Permission.Ruleset) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

const ask = {
  id: Permission.ID.create("per_precedence"),
  sessionID,
  action: at.action,
  resources: [at.resource],
} satisfies Permission.AssertInput

describe("configured rules vs saved approvals (pinned)", () => {
  itPermission.effect("a saved allow elevates a configured ask but never a configured deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: at.action, resources: [at.resource] })
      const service = yield* Permission.Service
      yield* setRules([{ action: at.action, resource: "*", effect: "ask" }])
      expect(yield* service.ask({ ...ask })).toMatchObject({ effect: "allow" })
      yield* setRules([{ action: at.action, resource: "*", effect: "deny" }])
      expect(yield* service.ask({ ...ask })).toMatchObject({ effect: "deny" })
    }),
  )
})
