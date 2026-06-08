import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"

export type LifecycleState = 
  | "idle" 
  | "planning" 
  | "executing" 
  | "verifying" 
  | "waiting_for_permission" 
  | "completed" 
  | "failed"
  | "unavailable"

export interface SessionLifecycle {
  sessionID: string
  state: LifecycleState
  reason?: string
  lastUpdatedAt: number
}

export interface LifecycleContextType {
  getLifecycle: (sessionID: string) => SessionLifecycle
  setLifecycle: (sessionID: string, state: LifecycleState, reason?: string) => void
}

export const { use: useLifecycle, provider: LifecycleProvider } = createSimpleContext({
  name: "Lifecycle",
  init: () => {
    const [lifecycles, setLifecycles] = createStore<Record<string, SessionLifecycle>>({})

    const getLifecycle = (sessionID: string): SessionLifecycle => {
      const existing = lifecycles[sessionID]
      if (existing) return existing
      return {
        sessionID,
        state: "idle",
        lastUpdatedAt: Date.now()
      }
    }

    const setLifecycle = (sessionID: string, state: LifecycleState, reason?: string) => {
      setLifecycles(
        produce((draft) => {
          draft[sessionID] = {
            sessionID,
            state,
            reason,
            lastUpdatedAt: Date.now()
          }
        })
      )
    }

    return {
      getLifecycle,
      setLifecycle,
    }
  },
})
