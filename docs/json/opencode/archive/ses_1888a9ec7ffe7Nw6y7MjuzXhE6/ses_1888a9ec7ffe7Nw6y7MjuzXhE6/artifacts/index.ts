export const BASE_URL = "opencode.ai"
export const DESKTOP_FEEDBACK_URL = "https://opencode.ai/desktop-feedback"
export const CHANGELOG_URL = "https://opencode.ai/changelog.json"

export const DEFAULT_PORT = 4096
export const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}`

export const TIMEOUTS = {
  SERVER_HEALTH: 3000,
  SERVER_HEALTH_RETRY_DELAY: 100,
  SERVER_HEALTH_CACHE_MS: 750,
  CONNECTION_RETRY_MS: 1000,
  POLL_INTERVAL_MS: 10000,
} as const

export const STORAGE_KEYS = {
  DEFAULT_SERVER_URL: "opencode.settings.dat:defaultServerUrl",
  LANGUAGE: "opencode.global.dat:language",
} as const
