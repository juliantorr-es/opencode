import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { app } from "electron"

function determineBinDir(): string {
  if (platform() === "win32") {
    const userProfile = process.env.USERPROFILE ?? homedir()
    return join(userProfile, ".opencode", "bin")
  }

  // Unix/Mac: XDG_BIN_HOME, ~/.local/bin, ~/bin
  const xdgBinHome = process.env.XDG_BIN_HOME
  if (xdgBinHome) return xdgBinHome

  const home = homedir()
  const localBin = join(home, ".local", "bin")
  if (existsSync(localBin)) return localBin

  return join(home, "bin")
}

function determineEntryPath(): string {
  if (app.isPackaged) {
    // In packaged mode, the opencode CLI/server should be bundled in resources
    const resourcePath = join(process.resourcesPath, "opencode", "node.js")
    if (existsSync(resourcePath)) return resourcePath
    throw new Error(
      "OpenCode CLI not found in application resources. The CLI must be bundled with the packaged app.",
    )
  }

  // Development mode: resolve relative to the compiled output in out/main/
  // out/main/../../opencode/dist/node/node.js → packages/opencode/dist/node/node.js
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const devEntry = resolve(currentDir, "../../opencode/dist/node/node.js")
  if (existsSync(devEntry)) return devEntry

  throw new Error(
    `OpenCode entry not found at development path: ${devEntry}. Run 'bun run build' in packages/opencode first.`,
  )
}

function validateShellCommand(command: string): string {
  // Basic validation: reject paths with shell metacharacters
  if (/[;&|`$(){}[\]!#~<>*?]/.test(command)) {
    throw new Error(`Invalid characters in shell command path: ${command}`)
  }
  return command
}

function createUnixWrapper(binDir: string, entryPath: string): string {
  const wrapperPath = join(binDir, "opencode")
  const escapedEntry = entryPath.replace(/'/g, "'\\''")

  const script = `#!/bin/sh
# OpenCode CLI — installed by OpenCode Desktop
set -e
OPENCODE_ENTRY='${escapedEntry}'
if command -v bun >/dev/null 2>&1; then
  exec bun run "$OPENCODE_ENTRY" "$@"
elif command -v node >/dev/null 2>&1; then
  exec node "$OPENCODE_ENTRY" "$@"
else
  echo "Error: bun or node is required to run OpenCode" >&2
  exit 1
fi
`

  writeFileSync(wrapperPath, script, "utf-8")
  chmodSync(wrapperPath, 0o755)
  return wrapperPath
}

function createWindowsCmdWrapper(binDir: string, entryPath: string): string {
  const wrapperPath = join(binDir, "opencode.cmd")
  const content = `@echo off
node "${entryPath}" %*
`
  writeFileSync(wrapperPath, content, "utf-8")
  return wrapperPath
}

function createWindowsPs1Wrapper(binDir: string, entryPath: string): string {
  const wrapperPath = join(binDir, "opencode.ps1")
  const content = `# OpenCode CLI — installed by OpenCode Desktop
$nodePath = if (Get-Command bun -ErrorAction SilentlyContinue) { "bun" } else { "node" }
& $nodePath "${entryPath}" @args
`
  writeFileSync(wrapperPath, content, "utf-8")
  return wrapperPath
}

export async function installCli(): Promise<string> {
  try {
    const binDir = determineBinDir()
    const entryPath = determineEntryPath()

    // Validate the entry path before creating wrappers
    validateShellCommand(entryPath)

    // Create bin directory if needed
    mkdirSync(binDir, { recursive: true })

    // Create wrapper scripts
    const isWindows = platform() === "win32"

    if (isWindows) {
      createWindowsCmdWrapper(binDir, entryPath)
      createWindowsPs1Wrapper(binDir, entryPath)
      return join(binDir, "opencode.cmd")
    }

    const wrapperPath = createUnixWrapper(binDir, entryPath)
    return wrapperPath
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to install OpenCode CLI: ${message}`)
  }
}
