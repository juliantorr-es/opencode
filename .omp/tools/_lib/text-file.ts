import { existsSync, readFileSync, statSync } from "node:fs"

const binaryExtensions: Record<string, true> = {
  ".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true,
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true, ".tiff": true,
  ".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
  ".mp3": true, ".mp4": true, ".wav": true, ".ogg": true, ".avi": true, ".mov": true, ".mkv": true,
  ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".wasm": true,
  ".db": true, ".sqlite": true, ".sqlite3": true,
  ".class": true, ".jar": true,
  ".o": true, ".obj": true, ".a": true, ".lib": true,
  ".woff": true, ".woff2": true, ".ttf": true, ".eot": true,
  ".bin": true, ".dat": true,
}

export function isTextFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  if (isBinaryByExtension(filePath)) return false

  try {
    const buf = readFileSync(filePath)
    const sample = buf.subarray(0, Math.min(4096, buf.length))
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return false
    }
    return true
  } catch {
    return false
  }
}

export function isBinary(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  return !isTextFile(filePath)
}

export function isBinaryByExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
  return ext in binaryExtensions
}

export function fileSize(filePath: string): number {
  if (!existsSync(filePath)) return 0
  return statSync(filePath).size
}
