import { spawn } from "node:child_process"

export interface SubprocessResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  ok: boolean
}

export const SUBPROCESS_OUTPUT_LIMIT = 10 * 1024 * 1024 // 10 MiB

export const ALLOWED_ENV = new Set([
  "PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG",
  "RUSTUP_HOME", "CARGO_HOME",
])

export function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ALLOWED_ENV) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}

export function governedRun(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
  const env = sanitizeEnv()
  const child = spawn(command, args, {
    cwd: opts?.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let stdout = ""
  let stderr = ""
  let truncated = false
  child.stdout.on("data", (d: Buffer) => {
    if (stdout.length < SUBPROCESS_OUTPUT_LIMIT) {
      stdout += d.toString()
      if (stdout.length >= SUBPROCESS_OUTPUT_LIMIT) {
        stdout = stdout.slice(0, SUBPROCESS_OUTPUT_LIMIT) + "\n[OUTPUT TRUNCATED]"
        truncated = true
      }
    }
  })
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < SUBPROCESS_OUTPUT_LIMIT) {
      stderr += d.toString()
      if (stderr.length >= SUBPROCESS_OUTPUT_LIMIT) {
        stderr = stderr.slice(0, SUBPROCESS_OUTPUT_LIMIT) + "\n[OUTPUT TRUNCATED]"
        truncated = true
      }
    }
  })
  let killed = false
  const killGroup = () => {
    if (killed) return
    killed = true
    try { process.kill(-child.pid!, "SIGTERM") } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL") } catch { /* already gone */ } }, 5000)
  }
  const timer = opts?.timeout ? setTimeout(killGroup, opts.timeout) : null
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer)
    resolve({
      stdout: truncated ? stdout.slice(0, SUBPROCESS_OUTPUT_LIMIT) : stdout,
      stderr: truncated ? stderr.slice(0, SUBPROCESS_OUTPUT_LIMIT) : stderr,
      code, signal, ok: code === 0,
    })
  })
  child.on("error", (err) => {
    if (timer) clearTimeout(timer)
    resolve({ stdout, stderr: err.message, code: null, signal: null, ok: false })
  })
  })
}
