import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { checkGitStatus } from "@/ambient/watchers/git-status"
import { checkTestStatus } from "@/ambient/watchers/test-status"
import { checkDeps } from "@/ambient/watchers/deps"
import { checkPRActivity } from "@/ambient/watchers/pr-activity"
import { checkSessionMemory } from "@/ambient/watchers/session-memory"

export type AmbientStatus = "ok" | "info" | "warning" | "alert"

export interface WatcherStatus {
  id: string
  label: string
  description: string
  icon: string
  status: AmbientStatus
  severity: number
  timestamp: number
  action?: { label: string; run: () => void }
  dismissible: boolean
}

export type WatcherCheck = () => Promise<WatcherStatus | null>

interface WatcherDef {
  id: string
  label: string
  check: WatcherCheck
  intervalMs: number
  enabled: boolean
}

type AmbientStore = {
  statuses: WatcherStatus[]
  lastChange: number
  showBar: boolean
}

const defaultStore: AmbientStore = {
  statuses: [],
  lastChange: 0,
  showBar: false,
}

export const { use: useAmbient, provider: AmbientProvider } = createSimpleContext({
  name: "Ambient",
  init: () => {
    const [store, setStore] = createStore<AmbientStore>(defaultStore)
    const dismissed = new Set<string>()
    const timers: number[] = []

    const addStatus = (status: WatcherStatus) => {
      if (dismissed.has(status.id)) return

      setStore("statuses", (prev) => {
        const existing = prev.findIndex((s) => s.id === status.id)
        if (existing >= 0) {
          const updated = [...prev]
          updated[existing] = status
          return updated
        }
        return [...prev, status]
      })

      batch(() => {
        setStore("lastChange", Date.now())
        setStore("showBar", true)
      })
    }

    const removeStatus = (id: string) => {
      setStore("statuses", (prev) => prev.filter((s) => s.id !== id))
      setStore("lastChange", Date.now())
    }

    const dismiss = (id: string) => {
      dismissed.add(id)
      removeStatus(id)
    }

    const undismiss = (id: string) => {
      dismissed.delete(id)
    }

    const runWatcher = async (def: WatcherDef) => {
      if (!def.enabled) return
      try {
        const result = await def.check()
        if (result) {
          addStatus(result)
        } else {
          removeStatus(def.id)
        }
      } catch {
        removeStatus(def.id)
      }
    }

    const registerWatchers = (defs: WatcherDef[]) => {
      for (const def of defs) {
        void runWatcher(def)
        const id = window.setInterval(() => void runWatcher(def), def.intervalMs)
        timers.push(id)
      }
    }

    createEffect(() => {
      registerWatchers([
        {
          id: "git",
          label: "Git",
          check: checkGitStatus,
          intervalMs: 30_000,
          enabled: true,
        },
        {
          id: "test",
          label: "Tests",
          check: checkTestStatus,
          intervalMs: 60_000,
          enabled: true,
        },
        {
          id: "deps",
          label: "Dependencies",
          check: checkDeps,
          intervalMs: 300_000,
          enabled: true,
        },
        {
          id: "pr",
          label: "Pull Requests",
          check: checkPRActivity,
          intervalMs: 120_000,
          enabled: true,
        },
        {
          id: "memory",
          label: "Session",
          check: checkSessionMemory,
          intervalMs: 60_000,
          enabled: true,
        },
      ])
    })

    onCleanup(() => {
      for (const t of timers) clearInterval(t)
    })

    return {
      get statuses() {
        return store.statuses
      },
      get lastChange() {
        return store.lastChange
      },
      get showBar() {
        return store.showBar
      },
      setShowBar(value: boolean) {
        setStore("showBar", value)
      },
      dismiss,
      undismiss,
    }
  },
})
