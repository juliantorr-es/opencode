import { getFilename } from "@opencode-ai/core/util/path"
import { pathKey } from "@/utils/path-key"

export interface WorkspaceLabelsStore {
  workspaceName: Record<string, string>
  workspaceBranchName: Record<string, Record<string, string>>
}

export type WorkspaceLabelsSetStore = (path: string, ...args: any[]) => void

export const workspaceName = (
  store: WorkspaceLabelsStore,
  directory: string,
  projectId?: string,
  branch?: string,
): string | undefined => {
  const key = pathKey(directory)
  const direct = store.workspaceName[key] ?? store.workspaceName[directory]
  if (direct) return direct
  if (!projectId) return
  if (!branch) return
  return store.workspaceBranchName[projectId]?.[branch]
}

export const setWorkspaceName = (
  store: WorkspaceLabelsStore,
  setStore: WorkspaceLabelsSetStore,
  directory: string,
  next: string,
  projectId?: string,
  branch?: string,
): void => {
  const key = pathKey(directory)
  setStore("workspaceName", key, next)
  if (!projectId) return
  if (!branch) return
  if (!store.workspaceBranchName[projectId]) {
    setStore("workspaceBranchName", projectId, {})
  }
  setStore("workspaceBranchName", projectId, branch, next)
}

export const workspaceLabel = (
  store: WorkspaceLabelsStore,
  directory: string,
  branch?: string,
  projectId?: string,
): string => workspaceName(store, directory, projectId, branch) ?? branch ?? getFilename(directory)
