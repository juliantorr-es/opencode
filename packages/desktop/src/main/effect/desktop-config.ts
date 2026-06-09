import { Context } from "effect"

/**
 * Immutable bootstrap configuration decoded once before root layer construction.
 *
 * All environment variable reads, command-line parsing, and path resolution
 * happen during bootstrap. Effect services and layers consume this typed
 * context — they never read process.env or process.argv directly.
 */
export interface DesktopBootstrapConfig {
  /** Release channel: dev, beta, or prod */
  readonly channel: "dev" | "beta" | "prod"
  /** Whether the app is packaged (production bundle vs dev) */
  readonly isPackaged: boolean
  /** Electron userData directory */
  readonly userDataPath: string
  /** User explicitly requested safe mode (--safe-mode flag or env) */
  readonly safeModeRequested: boolean
  /** Crash lock file exists from previous session */
  readonly crashDetected: boolean
  /** Running in safe mode (requested or crash-detected) */
  readonly safeMode: boolean
  /** Onboarding test mode (TRIBUNUS_TEST_ONBOARDING=1) */
  readonly testOnboarding: boolean
  /** In-memory database (TRIBUNUS_DB=:memory:) */
  readonly inMemoryDb: boolean
  /** Valkey coordination backend is enabled */
  readonly valkeyEnabled: boolean
  /** App version string */
  readonly appVersion: string
  /** App name for display */
  readonly appName: string
}

/**
 * Effect context reference for immutable bootstrap configuration.
 *
 * Provided once during bootstrap and never mutated. Services consume
 * this instead of reading process.env directly.
 */
export const DesktopConfigRef = Context.Reference<DesktopBootstrapConfig>(
  "~tribunus/DesktopConfig",
  { defaultValue: () => undefined as unknown as DesktopBootstrapConfig },
)
