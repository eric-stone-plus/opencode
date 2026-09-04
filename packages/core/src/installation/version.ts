declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
// Only "latest" builds are published to npm; pinning any other channel's version makes every plugin install fail.
export const InstallationPluginVersion = InstallationChannel === "latest" ? InstallationVersion : undefined
