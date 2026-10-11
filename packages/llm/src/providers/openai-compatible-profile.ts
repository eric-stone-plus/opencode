export interface OpenAICompatibleProfile {
  readonly provider: string
  readonly baseURL: string
}

export const profiles = {
  deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1" },
} as const satisfies Record<string, OpenAICompatibleProfile>

export const byProvider: Record<string, OpenAICompatibleProfile> = Object.fromEntries(
  Object.values(profiles).map((profile) => [profile.provider, profile]),
)
