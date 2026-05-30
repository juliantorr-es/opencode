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
  if (projectId && branch) {
    const byBranch = store.workspaceBranchName[projectId]
    if (byBranch && byBranch[branch]) return byBranch[branch]
  }
  if (projectId) {
    const name = store.workspaceName[projectId]
    if (name) return name
  }
  return store.workspaceName[directory]
}

export const setWorkspaceName = (
  store: WorkspaceLabelsStore,
  setStore: WorkspaceLabelsSetStore,
  directory: string,
  next: string,
  projectId?: string,
  branch?: string,
): void => {
  if (projectId && branch) {
    setStore("workspaceBranchName", projectId, branch, next)
  } else if (projectId) {
    setStore("workspaceName", projectId, next)
  } else {
    setStore("workspaceName", directory, next)
  }
}

export const workspaceLabel = (
  store: WorkspaceLabelsStore,
  directory: string,
  branch?: string,
  projectId?: string,
): string => {
  const name = workspaceName(store, directory, projectId, branch)
  if (name) return name
  if (branch) return `${directory} (${branch})`
  return directory
}
