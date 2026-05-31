import { spawnLocalServer, type HealthCheck, type SidecarListener } from "./server"
import { getLogger } from "./logging"
import type { StorageMigrationProgress } from "../preload/types"

export interface WatchdogOptions {
  hostname: string; port: number; password: string
  needsMigration: boolean; userDataPath: string
  onMigrationProgress?: (p: StorageMigrationProgress) => void
  onStdout?: (msg: string) => void; onStderr?: (msg: string) => void
  onCrash?: (count: number) => void
}

const MAX_RESTARTS = 3
const BACKOFFS = [1000, 2000, 4000]
const BACKOFF_CEILING = 30_000

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function createWatchdog(opts: WatchdogOptions) {
  const log = getLogger()
  let ref: SidecarListener | null = null
  let crashes = 0
  let stopped = false

  const baseOpts = {
    needsMigration: opts.needsMigration,
    userDataPath: opts.userDataPath,
    onMigrationProgress: opts.onMigrationProgress,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  }

  async function spawnAttempt(): Promise<{ listener: SidecarListener; health: HealthCheck }> {
    let ready = false
    return spawnLocalServer(opts.hostname, opts.port, opts.password, {
      ...baseOpts,
      onExit: () => {
        if (ready) {
          crashes++
          opts.onCrash?.(crashes)
          if (!stopped) void restartAfterCrash()
        }
      },
    }).then((result) => {
      ready = true
      return result
    })
  }

  async function restartAfterCrash() {
    for (let attempt = 0; attempt < MAX_RESTARTS && !stopped; attempt++) {
      const backoff = Math.min(BACKOFFS[attempt] ?? BACKOFF_CEILING, BACKOFF_CEILING)
      await wait(backoff)
      if (stopped) return
      try {
        const result = await spawnAttempt()
        ref = result.listener
        log.log("watchdog sidecar restarted", { attempt: attempt + 1, crashes })
        return
      } catch (error) {
        log.error("watchdog restart failed", { attempt: attempt + 1, error })
      }
    }
    log.error("watchdog exhausted post-crash restarts", { crashes })
  }

  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(BACKOFFS[attempt - 1] ?? BACKOFF_CEILING, BACKOFF_CEILING)
      await wait(backoff)
    }
    try {
      const result = await spawnAttempt()
      ref = result.listener
      return {
        listener: {
          stop: async () => {
            stopped = true
            await ref?.stop()
          },
        },
        health: result.health,
      }
    } catch (error) {
      log.error("sidecar spawn attempt failed", { attempt, error })
    }
  }

  throw new Error(`Sidecar failed to start after ${MAX_RESTARTS + 1} attempts`)
}
