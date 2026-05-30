import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function installCli(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("opencode", ["--version"])
    return stdout.trim()
  } catch (err) {
    throw new Error(
      `installCli: failed to exec opencode --version: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
