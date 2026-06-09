import { Context, Duration, Effect, Layer } from "effect"
import { Global } from "@tribunus/core/global"
import { AppFileSystem } from "@tribunus/core/filesystem"
import * as Log from "@tribunus/core/util/log"
import { which } from "@/util/which"
import path from "path"
import { spawnSync } from "child_process"

const log = Log.create({ service: "BinaryManager" })

// ─── Binary Descriptors ──────────────────────────────────────────────────────

export type BinaryName = "rg" | "fd" | "bat" | "delta" | "difft" | "eza"

interface BinaryDescriptor {
  readonly name: BinaryName
  readonly version: string
  readonly repo: string
  readonly binaryName: string
  readonly platforms: Record<string, { artifact: string; binaryPath: string }>
}

const PLATFORM_KEY = `${process.platform}-${process.arch}`
  .replace("darwin-arm64", "arm64-darwin")
  .replace("darwin-x64", "x64-darwin")
  .replace("linux-x64", "x64-linux")
  .replace("linux-arm64", "arm64-linux")
  .replace("win32-x64", "x64-windows")
  .replace("win32-arm64", "arm64-windows")

const BINARIES: BinaryDescriptor[] = [
  {
    name: "rg",
    version: "15.1.0",
    repo: "BurntSushi/ripgrep",
    binaryName: process.platform === "win32" ? "rg.exe" : "rg",
    platforms: {
      "arm64-darwin": { artifact: "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz", binaryPath: `ripgrep-15.1.0-aarch64-apple-darwin/rg` },
      "x64-darwin": { artifact: "ripgrep-15.1.0-x86_64-apple-darwin.tar.gz", binaryPath: `ripgrep-15.1.0-x86_64-apple-darwin/rg` },
      "arm64-linux": { artifact: "ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz", binaryPath: `ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg` },
      "x64-linux": { artifact: "ripgrep-15.1.0-x86_64-unknown-linux-gnu.tar.gz", binaryPath: `ripgrep-15.1.0-x86_64-unknown-linux-gnu/rg` },
      "x64-windows": { artifact: "ripgrep-15.1.0-x86_64-pc-windows-msvc.tar.gz", binaryPath: `ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe` },
    },
  },
  {
    name: "fd",
    version: "10.2.0",
    repo: "sharkdp/fd",
    binaryName: process.platform === "win32" ? "fd.exe" : "fd",
    platforms: {
      "arm64-darwin": { artifact: "fd-v10.2.0-aarch64-apple-darwin.tar.gz", binaryPath: `fd-v10.2.0-aarch64-apple-darwin/fd` },
      "x64-darwin": { artifact: "fd-v10.2.0-x86_64-apple-darwin.tar.gz", binaryPath: `fd-v10.2.0-x86_64-apple-darwin/fd` },
      "arm64-linux": { artifact: "fd-v10.2.0-aarch64-unknown-linux-gnu.tar.gz", binaryPath: `fd-v10.2.0-aarch64-unknown-linux-gnu/fd` },
      "x64-linux": { artifact: "fd-v10.2.0-x86_64-unknown-linux-gnu.tar.gz", binaryPath: `fd-v10.2.0-x86_64-unknown-linux-gnu/fd` },
      "x64-windows": { artifact: "fd-v10.2.0-x86_64-pc-windows-msvc.zip", binaryPath: `fd.exe` },
    },
  },
  {
    name: "bat",
    version: "0.25.0",
    repo: "sharkdp/bat",
    binaryName: process.platform === "win32" ? "bat.exe" : "bat",
    platforms: {
      "arm64-darwin": { artifact: "bat-v0.25.0-aarch64-apple-darwin.tar.gz", binaryPath: `bat-v0.25.0-aarch64-apple-darwin/bat` },
      "x64-darwin": { artifact: "bat-v0.25.0-x86_64-apple-darwin.tar.gz", binaryPath: `bat-v0.25.0-x86_64-apple-darwin/bat` },
      "arm64-linux": { artifact: "bat-v0.25.0-aarch64-unknown-linux-gnu.tar.gz", binaryPath: `bat-v0.25.0-aarch64-unknown-linux-gnu/bat` },
      "x64-linux": { artifact: "bat-v0.25.0-x86_64-unknown-linux-gnu.tar.gz", binaryPath: `bat-v0.25.0-x86_64-unknown-linux-gnu/bat` },
      "x64-windows": { artifact: "bat-v0.25.0-x86_64-pc-windows-msvc.zip", binaryPath: `bat.exe` },
    },
  },
  {
    name: "delta",
    version: "0.18.2",
    repo: "dandavison/delta",
    binaryName: process.platform === "win32" ? "delta.exe" : "delta",
    platforms: {
      "arm64-darwin": { artifact: "delta-0.18.2-aarch64-apple-darwin.tar.gz", binaryPath: `delta-0.18.2-aarch64-apple-darwin/delta` },
      "x64-darwin": { artifact: "delta-0.18.2-x86_64-apple-darwin.tar.gz", binaryPath: `delta-0.18.2-x86_64-apple-darwin/delta` },
      "arm64-linux": { artifact: "delta-0.18.2-aarch64-unknown-linux-gnu.tar.gz", binaryPath: `delta-0.18.2-aarch64-unknown-linux-gnu/delta` },
      "x64-linux": { artifact: "delta-0.18.2-x86_64-unknown-linux-gnu.tar.gz", binaryPath: `delta-0.18.2-x86_64-unknown-linux-gnu/delta` },
      "x64-windows": { artifact: "delta-0.18.2-x86_64-pc-windows-msvc.tar.gz", binaryPath: `delta.exe` },
    },
  },
  {
    name: "difft",
    version: "0.63.0",
    repo: "Wilfred/difftastic",
    binaryName: process.platform === "win32" ? "difft.exe" : "difft",
    platforms: {
      "arm64-darwin": { artifact: "difft-aarch64-apple-darwin.tar.gz", binaryPath: `difft` },
      "x64-darwin": { artifact: "difft-x86_64-apple-darwin.tar.gz", binaryPath: `difft` },
      "arm64-linux": { artifact: "difft-aarch64-unknown-linux-gnu.tar.gz", binaryPath: `difft` },
      "x64-linux": { artifact: "difft-x86_64-unknown-linux-gnu.tar.gz", binaryPath: `difft` },
      "x64-windows": { artifact: "difft-x86_64-pc-windows-msvc.tar.gz", binaryPath: `difft.exe` },
    },
  },
  {
    name: "eza",
    version: "0.20.16",
    repo: "eza-community/eza",
    binaryName: process.platform === "win32" ? "eza.exe" : "eza",
    platforms: {
      "arm64-darwin": { artifact: "eza_aarch64-apple-darwin.tar.gz", binaryPath: `eza` },
      "x64-darwin": { artifact: "eza_x86_64-apple-darwin.tar.gz", binaryPath: `eza` },
      "arm64-linux": { artifact: "eza_aarch64-unknown-linux-gnu.tar.gz", binaryPath: `eza` },
      "x64-linux": { artifact: "eza_x86_64-unknown-linux-gnu.tar.gz", binaryPath: `eza` },
    },
  },
]

// ─── Service Interface ────────────────────────────────────────────────────────

export interface Interface {
  readonly resolve: (name: BinaryName) => Effect.Effect<string>
  readonly check: (name: BinaryName) => Effect.Effect<boolean>
  readonly info: () => Effect.Effect<ReadonlyArray<{ name: string; version: string; path: string | null; status: string }>>
  readonly download: (name: BinaryName) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/BinaryManager") {}

// ─── Implementation ───────────────────────────────────────────────────────────

const make = Effect.gen(function* () {
  const fs = yield* AppFileSystem.Service

  const cacheDir = path.join(Global.Path.cache, "binaries")
  yield* fs.ensureDir(cacheDir)

  function getBinary(name: BinaryName): BinaryDescriptor {
    const binary = BINARIES.find((b) => b.name === name)
    if (!binary) throw new Error(`Unknown binary: ${name}`)
    return binary
  }

  function getPlatform(binary: BinaryDescriptor): { artifact: string; binaryPath: string } | null {
    return binary.platforms[PLATFORM_KEY] ?? null
  }

  function localPath(binary: BinaryDescriptor): string {
    return path.join(cacheDir, binary.binaryName)
  }

  const resolve = (name: BinaryName): Effect.Effect<string> =>
    Effect.gen(function* () {
      const binary = getBinary(name)
      const local = localPath(binary)

      // Check cache first
      const cached = yield* fs.existsSafe(local)
      if (cached) {
        yield* effectSpawn("chmod", ["+x", local])
        return local
      }

      // Check if system has it
      const sysPath = yield* Effect.sync(() => which(binary.binaryName))
      if (sysPath) return sysPath

      // Try to check system without which (for non-standard paths)
      const checkProc = yield* Effect.sync(() => {
        const r = spawnSync("which", [binary.binaryName], { encoding: "utf8", timeout: 5000 })
        return { found: r.status === 0, path: r.stdout?.trim() ?? "" }
      })
      if (checkProc.found && checkProc.path) return checkProc.path

      // Auto-download
      log.info(`Binary ${name} not found locally or on PATH. Downloading...`)
      return yield* download(name)
    })

  const check = (name: BinaryName): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const binary = getBinary(name)
      const local = localPath(binary)
      const cached = yield* fs.existsSafe(local)
      if (cached) return true
      const sysPath = yield* Effect.sync(() => which(binary.binaryName))
      return !!sysPath
    })

  const info = (): Effect.Effect<ReadonlyArray<{ name: string; version: string; path: string | null; status: string }>> =>
    Effect.gen(function* () {
      const result: Array<{ name: string; version: string; path: string | null; status: string }> = []
      for (const binary of BINARIES) {
        const local = localPath(binary)
        const cached = yield* fs.existsSafe(local)
        const sysPath = yield* Effect.sync(() => which(binary.binaryName))
        const platformInfo = getPlatform(binary)
        result.push({
          name: binary.name,
          version: binary.version,
          path: cached ? local : sysPath ?? null,
          status: cached ? "cached" : sysPath ? "system" : platformInfo ? "downloadable" : "unsupported",
        })
      }
      return result
    })

  const download = (name: BinaryName): Effect.Effect<string> =>
    Effect.gen(function* () {
      const binary = getBinary(name)
      const platformInfo = getPlatform(binary)
      if (!platformInfo) {
        return yield* Effect.die(new Error(`Platform ${PLATFORM_KEY} not supported for ${name}`))
      }

      const downloadUrl = `https://github.com/${binary.repo}/releases/download/${binary.name === "difft" ? binary.version : `v${binary.version}`}/${platformInfo.artifact}`
      const localPath_ = localPath(binary)
      const tempDir = path.join(cacheDir, `${binary.name}-${binary.version}`)

      log.info(`Downloading ${name} v${binary.version} from ${downloadUrl}`)

      // Download via curl (handles binary data reliably)
      const archivePath = path.join(cacheDir, platformInfo.artifact)
      yield* effectSpawn("curl", ["-fsSL", "-o", archivePath, downloadUrl])
      yield* fs.ensureDir(tempDir).pipe(Effect.catch(() => Effect.void))

      // Extract
      if (platformInfo.artifact.endsWith(".zip")) {
        yield* effectSpawn("unzip", ["-o", archivePath, "-d", tempDir])
      } else {
        yield* effectSpawn("tar", ["xzf", archivePath, "-C", tempDir])
      }

      // Move binary to cache root
      const extractedBinary = path.join(tempDir, platformInfo.binaryPath)
      yield* effectSpawn("cp", [extractedBinary, localPath_])
      yield* effectSpawn("chmod", ["+x", localPath_])

      // Cleanup
      yield* effectSpawn("rm", ["-rf", archivePath, tempDir])

      log.info(`Binary ${name} installed to ${localPath_}`)
      return localPath_
    })

  return { resolve, check, info, download } satisfies Interface
})

function effectSpawn(cmd: string, args: string[]): Effect.Effect<string> {
  return (Effect.sync(() => {
    const r = spawnSync(cmd, args, { encoding: "utf8" as const, timeout: 30000 })
    if (r.error) throw r.error
    return r.stdout ?? ""
  }) as Effect.Effect<string>)
}

// ─── Layer ────────────────────────────────────────────────────────────────────

export const layer = Layer.effect(Service, make)
export const defaultLayer = layer
