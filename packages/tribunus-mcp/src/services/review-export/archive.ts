import { openSync, closeSync, writeSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, readSync } from "node:fs"
import { basename, dirname, resolve, relative } from "node:path"
import { createHash } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import type { ReviewExportProgressSinkV1 } from "./progress.js"

// ─── CRC-32 ───────────────────────────────────────────────

const CRC32_TABLE = new Uint32Array(
  Array.from({ length: 256 }, (_, i) => {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c
  }),
)

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ─── ZIP struct helpers ───────────────────────────────────

const LOCAL_HEADER_BASE = 30 // sig(4)+ver(2)+flags(2)+method(2)+time(2)+date(2)+crc(4)+csize(4)+usize(4)+nameLen(2)+extraLen(2)
const CD_ENTRY_BASE = 46 // sig(4)+vMade(2)+vNeed(2)+flags(2)+method(2)+time(2)+date(2)+crc(4)+csize(4)+usize(4)+nameLen(2)+extraLen(2)+commentLen(2)+disk(2)+iattr(2)+eattr(4)+off(4)
const EOCD_SIZE = 22

function putU16(buf: Buffer, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
}

function putU32(buf: Buffer, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
  buf[off + 2] = (v >>> 16) & 0xff
  buf[off + 3] = (v >>> 24) & 0xff
}

// ─── File listing (sorted bytewise by relative path) ─────

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = resolve(current, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else files.push(abs)
    }
  }
  walk(dir, "")
  return files
}

// ─── Streaming SHA-256 (chunked, not readFileSync) ────────

function streamingSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(65536);
  let bytesRead: number;
  while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, bytesRead));
  }
  closeSync(fd);
  return hash.digest("hex");
}

// ─── Shared zip writer ────────────────────────────────────
// Writes local file entries + central directory + EOCD for a list of {
// absPath, zipName } pairs. Returns the cdEntries for size tracking.

function writeZipEntries(
  fd: number,
  entries: Array<{ absPath: string; zipName: string }>,
): Array<{ name: string; crc: number; csize: number; usize: number; localOff: number }> {
  const cdEntries: Array<{ name: string; crc: number; csize: number; usize: number; localOff: number }> = []
  let writerOff = 0

  // Phase 1: local file entries
  for (const { absPath, zipName } of entries) {
    const nameBytes = Buffer.byteLength(zipName)
    const content = readFileSync(absPath)
    const rawCrc = crc32(content)
    const compressed = deflateRawSync(content, { level: 6 })
    const usize = content.length
    const csize = compressed.length

    const hdr = Buffer.allocUnsafe(LOCAL_HEADER_BASE + nameBytes)
    putU32(hdr, 0, 0x04034b50)
    putU16(hdr, 4, 20)
    putU16(hdr, 6, 0x0800)
    putU16(hdr, 8, 8)
    putU16(hdr, 10, 0)
    putU16(hdr, 12, 0)
    putU32(hdr, 14, rawCrc)
    putU32(hdr, 18, csize)
    putU32(hdr, 22, usize)
    putU16(hdr, 26, nameBytes)
    putU16(hdr, 28, 0)
    hdr.write(zipName, 30, nameBytes, "utf8")

    writeSync(fd, hdr)
    writeSync(fd, compressed)

    cdEntries.push({ name: zipName, crc: rawCrc, csize, usize, localOff: writerOff })
    writerOff += LOCAL_HEADER_BASE + nameBytes + csize
  }

  // Phase 2: central directory
  const cdOff = writerOff

  for (const entry of cdEntries) {
    const nameBytes = Buffer.byteLength(entry.name)
    const hdr = Buffer.allocUnsafe(CD_ENTRY_BASE + nameBytes)
    putU32(hdr, 0, 0x02014b50)
    putU16(hdr, 4, 0x0314)
    putU16(hdr, 6, 20)
    putU16(hdr, 8, 0x0800)
    putU16(hdr, 10, 8)
    putU16(hdr, 12, 0)
    putU16(hdr, 14, 0)
    putU32(hdr, 16, entry.crc)
    putU32(hdr, 20, entry.csize)
    putU32(hdr, 24, entry.usize)
    putU16(hdr, 28, nameBytes)
    putU16(hdr, 30, 0)
    putU16(hdr, 32, 0)
    putU16(hdr, 34, 0)
    putU16(hdr, 36, 0)
    putU32(hdr, 38, 0)
    putU32(hdr, 42, entry.localOff)
    hdr.write(entry.name, 46, nameBytes, "utf8")

    writeSync(fd, hdr)
    writerOff += CD_ENTRY_BASE + nameBytes
  }

  // Phase 3: end of central directory
  const cdSize = writerOff - cdOff
  const count = cdEntries.length
  const eocd = Buffer.allocUnsafe(EOCD_SIZE)
  putU32(eocd, 0, 0x06054b50)
  putU16(eocd, 4, 0)
  putU16(eocd, 6, 0)
  putU16(eocd, 8, count)
  putU16(eocd, 10, count)
  putU32(eocd, 12, cdSize)
  putU32(eocd, 16, cdOff)
  putU16(eocd, 20, 0)
  writeSync(fd, eocd)

  return cdEntries
}

// ─── Public API ───────────────────────────────────────────

export type ZipArchiveBackendV1 = {
  kind: "zip-stream"
  zipDirectory(args: {
    source_dir: string
    archive_path: string
    stage: "semantic_zip" | "source_zip"
    progress?: ReviewExportProgressSinkV1
  }): {
    archive_path: string
    entries_written: number
    bytes_written: number
    size_bytes: number
    sha256: string
  }
  zipManifest(args: {
    source_dir: string
    archive_path: string
    entries: string[]
    progress?: ReviewExportProgressSinkV1
  }): {
    archive_path: string
    entries_written: number
    size_bytes: number
    sha256: string
  }
}

export function createZipCliArchiveBackend(): ZipArchiveBackendV1 {
  return {
    kind: "zip-stream",

    zipDirectory(args) {
      const absPaths = listFilesRecursive(args.source_dir)
      const prefix = basename(args.source_dir)

      args.progress?.({
        stage: args.stage,
        status: "start",
        entries_written: 0,
        bytes_written: 0,
        message: `Packing ${absPaths.length} file(s) with zip-stream`,
      })

      const archiveDir = dirname(args.archive_path)
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
      rmSync(args.archive_path, { force: true })

      const fd = openSync(args.archive_path, "w")
      let cdEntries: Array<{ name: string; crc: number; csize: number; usize: number; localOff: number }>
      try {
        cdEntries = writeZipEntries(
          fd,
          absPaths.map((absPath) => ({
            absPath,
            zipName: `${prefix}/${relative(args.source_dir, absPath)}`,
          })),
        )
      } finally {
        closeSync(fd)
      }

      // ── SHA-256 of the final archive ──
      const sha256 = streamingSha256(args.archive_path)
      const sizeBytes = statSync(args.archive_path).size
      const totalUncompressed = absPaths.length

      args.progress?.({
        stage: args.stage,
        status: "done",
        entries_written: totalUncompressed,
        bytes_written: sizeBytes,
        message: `Wrote ${totalUncompressed} file(s) to ${args.archive_path}`,
      })

      return {
        archive_path: args.archive_path,
        entries_written: totalUncompressed,
        bytes_written: cdEntries.reduce((s, e) => s + e.usize, 0),
        size_bytes: sizeBytes,
        sha256,
      }
    },
    zipManifest(args) {
      args.progress?.({
        stage: "semantic_zip" as const,
        status: "start",
        entries_written: 0,
        bytes_written: 0,
        message: `Packing ${args.entries.length} manifest entry(s) with zip-stream`,
      });

      const archiveDir = dirname(args.archive_path);
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
      rmSync(args.archive_path, { force: true });

      const fd = openSync(args.archive_path, "w");
      try {
        writeZipEntries(
          fd,
          args.entries.map((relPath) => ({
            absPath: resolve(args.source_dir, relPath),
            zipName: relPath,
          })),
        );
      } finally {
        closeSync(fd);
      }

      const sha256 = streamingSha256(args.archive_path);
      const sizeBytes = statSync(args.archive_path).size;

      args.progress?.({
        stage: "semantic_zip" as const,
        status: "done",
        entries_written: args.entries.length,
        bytes_written: sizeBytes,
        message: `Wrote ${args.entries.length} manifest entry(s) to ${args.archive_path}`,
      });

      return {
        archive_path: args.archive_path,
        entries_written: args.entries.length,
        size_bytes: sizeBytes,
        sha256,
      };
    },
  }
}
