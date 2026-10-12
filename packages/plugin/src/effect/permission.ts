import type { PermissionApi } from "@opencode/client/effect/api"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { Effect } from "effect"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

/** One blocking permission gate; the runtime adds the source tool call to the audit trail. */
export interface PermissionAssert {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  /** Patterns saved when the user answers "always". */
  readonly save?: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
}

export type PermissionDomain = Pick<PermissionApi<unknown>, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
  /**
   * Request permission for an action and wait for the answer.
   *
   * Succeeds when a rule allows the action or the user approves the prompt.
   * Fails with a message-carrying error when a rule denies the action or the
   * user rejects with feedback. A rejection without feedback is a decline,
   * raised as an interruptive defect exactly like every built-in tool: never
   * catch it to keep going, or the user's "no" becomes a continuation.
   */
  readonly assert: (input: PermissionAssert) => Effect.Effect<void, Error>
}
