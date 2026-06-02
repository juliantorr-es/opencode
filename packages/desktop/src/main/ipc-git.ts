import { ipcMain } from "electron"
import { exec } from "child_process"
import { promisify } from "util"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

const execAsync = promisify(exec)

interface GitCheck {
  uncommitted: number
  unpushed: number
  mergeConflicts: number
  branch: string | null
}

async function getGitStatus(): Promise<GitCheck | null> {
  try {
    // Get branch name
    const { stdout: branchOut } = await execAsync("git rev-parse --abbrev-ref HEAD", { timeout: 5000 })
    const branch = branchOut.trim() || null

    // Count uncommitted changes (porcelain = one line per changed file)
    const { stdout: statusOut } = await execAsync("git status --porcelain", { timeout: 5000 })
    const uncommitted = statusOut.trim() ? statusOut.trim().split("\n").length : 0

    // Count merge conflicts (grep for 'both modified' or 'both added' in unmerged paths)
    const { stdout: conflictOut } = await execAsync("git diff --name-only --diff-filter=U", { timeout: 5000 })
    const mergeConflicts = conflictOut.trim() ? conflictOut.trim().split("\n").length : 0

    // Count unpushed commits
    let unpushed = 0
    try {
      const { stdout: unpushedOut } = await execAsync("git rev-list --count @{u}..HEAD", { timeout: 5000 })
      unpushed = Number.parseInt(unpushedOut.trim(), 10) || 0
    } catch {
      // No upstream configured — no unpushed count
    }

    return { uncommitted, unpushed, mergeConflicts, branch }
  } catch {
    // Not a git repository or git not available
    return null
  }
}
export function registerGitIpcHandlers() {
  ipcMain.handle(IPC.handle.GET_GIT_STATUS, async () => {
    return withIpcResult("git.status", () => getGitStatus())
  })
}
