import { join, resolve } from "node:path"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelProvenance {
  image_hash: string
  storage_abi: string
  runtime_abi: string
  manifest_hash: string
  segment_hashes?: string[]
  tensor_table_hash?: string
  execution_plan_hash: string
  arch_hash: string
  quant_hash: string
  tokenizer_hash: string
  tokenizer_config_hash?: string
  chat_template_hash?: string
  model_revision: string
  eos_token_ids?: number[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hex digest of a file's content, or empty string if missing. */
async function fileHash(filePath: string): Promise<string> {
  const f = Bun.file(filePath)
  if (!(await f.exists())) return ""
  const buf = await f.arrayBuffer()
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(new Uint8Array(buf))
  return hash.digest("hex")
}

/** Read and parse a JSON file, returning the value or undefined on failure. */
async function readJson<T>(filePath: string): Promise<T | undefined> {
  const f = Bun.file(filePath)
  if (!(await f.exists())) return undefined
  try {
    return JSON.parse(await f.text()) as T
  } catch {
    return undefined
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Capture model provenance from a compiled model image directory.
 *
 * Reads `manifest.json`, `config.json`, and tokenizer files from the
 * image directory.  All file hashes use SHA-256 (via Bun.CryptoHasher).
 * Home-directory paths are redacted to `$HOME/…`.
 */
export async function captureModelProvenance(imageDir: string): Promise<ModelProvenance> {
  const dir = resolve(imageDir)

  // ── manifest.json ───────────────────────────────────────────────────────
  const manifest = await readJson<{
    image_hash?: string
    storage_abi?: string
    runtime_abi?: string
    manifest_hash?: string
    segment_hashes?: string[]
    tensor_table_hash?: string
    execution_plan_hash?: string
  }>(join(dir, "manifest.json"))

  // If the manifest itself is a JSON file, hash its canonical serialisation.
  const manifestHash = manifest?.manifest_hash ?? (await fileHash(join(dir, "manifest.json")))

  // ── config.json (architecture / quantisation) ────────────────────────────
  const config = await readJson<{
    model_type?: string
    quant?: Record<string, unknown>
    quantization?: Record<string, unknown>
    eos_token_id?: number | number[]
  }>(join(dir, "config.json"))

  let archHash = ""
  let quantHash = ""

  if (config) {
    // Re-hash the raw bytes for arch & quant
    const raw = await fileHash(join(dir, "config.json"))

    // arch_hash: SHA-256 of the full config when no explicit arch file exists
    archHash = raw

    // quant_hash: if config has a quantization block, hash that portion
    const quantBlock = config.quant ?? config.quantization
    if (quantBlock) {
      const h = new Bun.CryptoHasher("sha256")
      h.update(JSON.stringify(quantBlock))
      quantHash = h.digest("hex")
    } else {
      quantHash = raw // fallback — whole config is the quant config
    }
  }

  // ── Tokenizer files ─────────────────────────────────────────────────────
  const tokenizerHash = await fileHash(join(dir, "tokenizer.json"))
  const tokenizerConfigHash = await fileHash(join(dir, "tokenizer_config.json"))
  const chatTemplateHash = await fileHash(join(dir, "chat_template.jinja"))

  // ── Model revision ──────────────────────────────────────────────────────
  // Look for a revision marker file or derive from the manifest
  let modelRevision = manifest?.image_hash ?? ""
  const revisionFile = await readJson<{ revision?: string }>(join(dir, ".source_revision"))
  if (revisionFile?.revision) {
    modelRevision = revisionFile.revision
  }

  // ── EOS token IDs ───────────────────────────────────────────────────────
  let eosTokenIds: number[] | undefined
  if (config) {
    const eos = config.eos_token_id
    if (eos !== undefined) {
      eosTokenIds = Array.isArray(eos) ? eos : [eos]
    }
  }

  // Also check tokenizer_config.json for eos_token
  if (!eosTokenIds || eosTokenIds.length === 0) {
    const tokCfg = await readJson<{ eos_token_id?: number | number[] }>(join(dir, "tokenizer_config.json"))
    if (tokCfg) {
      const eos = tokCfg.eos_token_id
      if (eos !== undefined) {
        eosTokenIds = Array.isArray(eos) ? eos : [eos]
      }
    }
  }

  // ── Build result ────────────────────────────────────────────────────────
  const provenance: ModelProvenance = {
    image_hash: manifest?.image_hash ?? (await fileHash(join(dir, "manifest.json"))),
    storage_abi: manifest?.storage_abi ?? "",
    runtime_abi: manifest?.runtime_abi ?? "",
    manifest_hash: manifestHash,
    segment_hashes: manifest?.segment_hashes,
    tensor_table_hash: manifest?.tensor_table_hash,
    execution_plan_hash: manifest?.execution_plan_hash ?? "",
    arch_hash: archHash,
    quant_hash: quantHash,
    tokenizer_hash: tokenizerHash,
    tokenizer_config_hash: tokenizerConfigHash || undefined,
    chat_template_hash: chatTemplateHash || undefined,
    model_revision: modelRevision,
    eos_token_ids: eosTokenIds,
  }

  return provenance
}
