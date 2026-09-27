import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import CONTRACT from "./autonomy.txt"
import REMINDER from "./autonomy-reminder.txt"

// Same predicate, same rulesets, as the gate that hides the question tool from
// the model (session/llm/request.ts resolveTools): agent rules merged with the
// session's, session last. Gating on the agent alone diverges — `opencode run`
// denies question at session level, so the tool would be hidden with no contract
// injected. Keep this in step with resolveTools.
function questionDenied(agent: Agent.Info, permission?: PermissionV1.Ruleset) {
  return Permission.disabled(["question"], Permission.merge(agent.permission, permission ?? [])).has("question")
}

// Injected once per turn into the system prompt.
export function contract(agent: Agent.Info, permission?: PermissionV1.Ruleset) {
  return questionDenied(agent, permission) ? CONTRACT.trim() : undefined
}

// Appended to each loaded skill, so the rule sits beside the instructions it
// overrides. Deliberately short: skill tool output is exempt from compaction
// pruning, so every copy is permanent.
export function reminder(agent: Agent.Info, permission?: PermissionV1.Ruleset) {
  return questionDenied(agent, permission) ? REMINDER.trim() : undefined
}

export * as SkillAutonomy from "./autonomy"
