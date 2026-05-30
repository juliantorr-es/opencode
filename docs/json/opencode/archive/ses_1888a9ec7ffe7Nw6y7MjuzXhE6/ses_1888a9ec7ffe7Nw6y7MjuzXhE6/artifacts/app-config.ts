import { app } from "electron"
import { CHANNEL, APP_IDS } from "./constants"

const GITHUB_CLIENT_ID = "Iv23li7XUy0RKw5TlZ3K"
const CUSTOM_PROTOCOL = "opencode"
const HEALTH_ENDPOINT = "/global/health"

export function getGithubClientId(): string {
  return process.env.OPENCODE_GITHUB_CLIENT_ID ?? GITHUB_CLIENT_ID
}

export function getHealthEndpoint(): string {
  return HEALTH_ENDPOINT
}

export function getCustomProtocol(): string {
  return CUSTOM_PROTOCOL
}

export function getAppIdentity(): string {
  return app.isPackaged ? APP_IDS[CHANNEL] : APP_IDS.dev
}
