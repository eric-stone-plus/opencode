// Decides whether the prompt's agent selector follows the session's last user
// message. It follows a *switch* of that message's agent (plan_exit landing,
// /goal, /goal clear) but not a new message that merely copies the previous
// agent — compaction auto-continue, output-length continue and task results
// do that, and following them would undo a selection the user just made.
export type AgentFollowState = { messageID?: string; agent?: string }

export function followAgent(
  prev: AgentFollowState,
  msg: { id: string; agent?: string },
): { state: AgentFollowState; agent?: string } {
  if (msg.id === prev.messageID) return { state: prev }
  const state = { messageID: msg.id, agent: msg.agent }
  if (!msg.agent || msg.agent === prev.agent) return { state }
  return { state, agent: msg.agent }
}
