import { Context } from "effect"

// Personal fork: upstream also trusted every https://*.opencode.ai origin so the
// hosted web app could drive a local server. That handed any page on those
// origins full API access; only local/desktop origins and explicit --cors
// entries are trusted here.
const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (localOrigin.test(input)) return true
  if (input === "oc://renderer") return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
