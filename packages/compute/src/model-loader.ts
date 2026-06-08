import type { TensorView } from "./tensor-view.js"

// ── Metadata ──────────────────────────────────────────────────────────────────

export interface ModelMetadata {
  readonly modelId: string
  readonly name: string
  readonly version: string
  readonly quantization?: string // e.g. "q4_0", "q8_0", "f16"
  readonly paramCount: number
  readonly fileSizeBytes: number
  readonly checksum: string // SHA-256
  readonly registryEntry: string // PGlite row id
}

export interface ModelLoader {
  load(modelId: string): Promise<{ metadata: ModelMetadata; tensors: Map<string, TensorView> }>
  unload(modelId: string): void
  listModels(): ModelMetadata[]
}

// ── In-memory registry entry ──────────────────────────────────────────────────

interface RegistryEntry {
  metadata: ModelMetadata
  tensors: Map<string, TensorView>
}

// ── Concrete implementation ───────────────────────────────────────────────────

export class SimpleModelLoader implements ModelLoader {
  private readonly registry = new Map<string, RegistryEntry>()

  /**
   * Register a model's metadata and tensor views so it can be loaded by id.
   * Useful for tests and non-persistent workflows.
   */
  register(metadata: ModelMetadata, tensors: Map<string, TensorView>): void {
    this.registry.set(metadata.modelId, { metadata, tensors })
  }

  /**
   * Remove a model from the registry entirely.
   */
  unregister(modelId: string): boolean {
    return this.registry.delete(modelId)
  }

  // ── ModelLoader ─────────────────────────────────────────────────────────────

  async load(modelId: string): Promise<{ metadata: ModelMetadata; tensors: Map<string, TensorView> }> {
    const entry = this.registry.get(modelId)
    if (!entry) {
      throw new Error(`Model not found: ${modelId}`)
    }
    return { metadata: entry.metadata, tensors: new Map(entry.tensors) }
  }

  unload(modelId: string): void {
    // In the simple loader, unloading just drops the local reference.
    // The underlying StorageHandles remain live if other references exist.
    this.registry.delete(modelId)
  }

  listModels(): ModelMetadata[] {
    const result: ModelMetadata[] = []
    for (const entry of this.registry.values()) {
      result.push(entry.metadata)
    }
    return result
  }
}
