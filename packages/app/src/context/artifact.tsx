import { createSimpleContext } from "@tribunus/ui/context"
import { createStore, produce } from "solid-js/store"
import { createSignal } from "solid-js"

export type ArtifactType = "text" | "markdown" | "json" | "receipt" | "html" | "image" | "file_preview" | "command_result"

export type ArtifactStatus = "generating" | "available" | "unavailable" | "error"

export type ArtifactRuntimeKind = "webcontainer" | "native-pty" | "remote" | "unknown"
export type ArtifactWorkspaceMode = "local" | "snapshot" | "synced" | "virtual_fs_sandbox" | "unknown"
export type ProducerTruth = "system" | "playwright" | "sidecar" | "terminal" | "dev" | string

export interface CommandArtifactMetadata {
  command: string
  cwd?: string
  startedAt: number
  completedAt?: number
  exitCode?: number
  signal?: string
  stdoutBytes?: number
  stderrBytes?: number
  stdout?: string
  stderr?: string
}

export interface Artifact {
  id: string
  sessionID: string
  type: ArtifactType
  title: string
  status: ArtifactStatus
  content?: string
  reason?: string
  timestamp: number

  producer?: ProducerTruth
  runtime?: ArtifactRuntimeKind
  workspaceMode?: ArtifactWorkspaceMode
  affectsRealWorkspace?: boolean
  source?: string
  contentReference?: string
  lifecycleRelation?: string
  commandMetadata?: CommandArtifactMetadata
}

export interface ArtifactContextType {
  artifacts: () => Artifact[]
  getArtifactsBySession: (sessionID: string) => Artifact[]
  getArtifact: (id: string) => Artifact | undefined
  addArtifact: (artifact: Artifact) => void
  updateArtifact: (id: string, updates: Partial<Artifact>) => void
  clearArtifacts: (sessionID: string) => void
  railOpened: () => boolean
  toggleRail: () => void
}

export const { use: useArtifacts, provider: ArtifactProvider } = createSimpleContext({
  name: "Artifacts",
  init: () => {
    const [artifacts, setArtifacts] = createStore<Artifact[]>([])
    const [railOpened, setRailOpened] = createSignal(false)

    const getArtifactsBySession = (sessionID: string) => artifacts.filter((a) => a.sessionID === sessionID)
    const getArtifact = (id: string) => artifacts.find((a) => a.id === id)

    const addArtifact = (artifact: Artifact) => {
      setArtifacts(produce((draft) => {
        draft.push(artifact)
      }))
    }

    const updateArtifact = (id: string, updates: Partial<Artifact>) => {
      setArtifacts(
        (a) => a.id === id,
        (current) => ({ ...current, ...updates })
      )
    }

    const clearArtifacts = (sessionID: string) => {
      setArtifacts(produce((draft) => {
        const remaining = draft.filter(a => a.sessionID !== sessionID)
        draft.length = 0
        draft.push(...remaining)
      }))
    }

    return {
      artifacts: () => artifacts,
      getArtifactsBySession,
      getArtifact,
      addArtifact,
      updateArtifact,
      clearArtifacts,
      railOpened,
      toggleRail: () => setRailOpened((o) => !o),
    }
  },
})
