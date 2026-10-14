import { createSimpleContext } from "./helper"

// The TUI always accepts permission requests automatically. The prompt/autoaccept
// choice and its Settings row were removed on purpose (fork decision), so the mode
// is a constant rather than a client-config read. Consumers keep their explicit
// guards against it, and the session route replies `once` to every request.
export type PermissionMode = "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => ({
    get mode(): PermissionMode {
      return "autoaccept"
    },
  }),
})
