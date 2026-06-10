/**
 * Stream Queue Adapter
 * 
 * Adapter that provides the old queue interface (enqueue/dequeue) on top of
 * the new stream-backed work queue.
 * 
 * This allows for gradual migration from LPUSH/RPUSH to stream-backed coordination.
 * 
 * Usage:
 * ```typescript
 * // Old way (LPUSH/RPUSH):
 * await fabric.enqueue("my-queue", job)
 * const job = await fabric.dequeue("my-queue")
 * 
 * // New way (stream-backed):
 * const adapter = new StreamQueueAdapter(workQueue, "my-queue")
 * await adapter.enqueue(job)
 * const job = await adapter.dequeue()
 * ```
 */

import type { CoordinationJob, BackpressureState } from "./fabric"
import { CoordinationWorkQueue, DEFAULT_CONFIG } from "./work-queue"
import type { WorkEnvelope, WorkQueueConfig } from "./work-queue"
import { ValkeyStreams } from "./stream-primitives"
import type { Redis } from "ioredis"

// ── Types ──────────────────────────────────────────────────────────────

/** Queue adapter configuration */
export interface StreamQueueAdapterConfig {
  /** Stream name for this queue */
  streamName: string
  /** Consumer group name */
  consumerGroup: string
  /** Consumer prefix for generating consumer IDs */
  consumerPrefix: string
  /** Block timeout in ms for dequeue */
  blockTimeoutMs: number
  /** Batch size for read operations */
  batchSize: number
}

/** Default adapter configuration */
export const DEFAULT_ADAPTER_CONFIG: StreamQueueAdapterConfig = {
  streamName: DEFAULT_CONFIG.streamName,
  consumerGroup: DEFAULT_CONFIG.consumerGroup,
  consumerPrefix: DEFAULT_CONFIG.consumerPrefix,
  blockTimeoutMs: DEFAULT_CONFIG.blockTimeoutMs,
  batchSize: DEFAULT_CONFIG.batchSize,
}

// ── Adapter ─────────────────────────────────────────────────────────────

/**
 * Stream Queue Adapter
 * 
 * Provides the old enqueue/dequeue interface on top of stream-backed work queue.
 * This allows for gradual migration from LPUSH/RPUSH to streams.
 */
export class StreamQueueAdapter {
  private readonly workQueue: CoordinationWorkQueue
  private readonly queueName: string
  private readonly config: StreamQueueAdapterConfig

  constructor(
    workQueue: CoordinationWorkQueue,
    queueName: string,
    config: Partial<StreamQueueAdapterConfig> = {}
  ) {
    this.workQueue = workQueue
    this.queueName = queueName
    this.config = { ...DEFAULT_ADAPTER_CONFIG, ...config }
  }

  // ── Queue Interface ───────────────────────────────────────────────────

  /**
   * Enqueue a job.
   * 
   * Converts the old CoordinationJob format to the new WorkEnvelope format
   * and publishes it to the stream.
   */
  async enqueue(job: CoordinationJob): Promise<void> {
    const envelope: WorkEnvelope = this.convertJobToEnvelope(job)
    await this.workQueue.publish(envelope)
  }

  /**
   * Dequeue a job.
   * 
   * Reads from the stream and converts back to CoordinationJob format.
   */
  async dequeue(): Promise<CoordinationJob | undefined> {
    const result = await this.workQueue.read({
      blockTimeoutMs: this.config.blockTimeoutMs,
      batchSize: this.config.batchSize,
    })
    
    if (!result) return undefined
    
    return this.convertEnvelopeToJob(result.work, result.entryId)
  }

  /**
   * Get backpressure state.
   * 
   * For now, this provides a basic implementation. The stream-backed queue
   * has more sophisticated pending inspection capabilities.
   */
  async backpressure(): Promise<BackpressureState> {
    // Get pending count from the stream
    const pending = await this.workQueue.getPending()
    
    return {
      queued: pending.length,
      processing: pending.length, // Approximate - pending entries are being processed
      throttled: pending.length > 100,
    }
  }

  // ── Conversion Methods ────────────────────────────────────────────────

  /**
   * Convert CoordinationJob to WorkEnvelope.
   */
  private convertJobToEnvelope(job: CoordinationJob): WorkEnvelope {
    return {
      workId: job.id,
      workKind: job.kind,
      schemaVersion: "v1",
      enqueuedAt: Date.now(),
      correlationId: job.correlationId ?? job.id,
      sessionId: job.sessionId,
      missionId: job.missionId,
      routingTags: job.tags,
      attemptHint: 1,
    }
  }

  /**
   * Convert WorkEnvelope and entry ID back to CoordinationJob.
   */
  private convertEnvelopeToJob(envelope: WorkEnvelope, entryId: string): CoordinationJob {
    return {
      id: envelope.workId,
      kind: envelope.workKind,
      correlationId: envelope.correlationId,
      sessionId: envelope.sessionId,
      missionId: envelope.missionId,
      tags: envelope.routingTags,
      payload: {}, // Payload would need to be stored separately
      resourceClass: "default",
      priority: 0,
      // Add metadata for tracking
      _streamEntryId: entryId,
      _enqueuedAt: envelope.enqueuedAt,
    }
  }

  // ── Stream Access ─────────────────────────────────────────────────────

  /**
   * Get the underlying work queue for advanced operations.
   */
  getWorkQueue(): CoordinationWorkQueue {
    return this.workQueue
  }

  /**
   * Get the queue name.
   */
  getQueueName(): string {
    return this.queueName
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a stream queue adapter for a specific queue name.
 */
export function createStreamQueueAdapter(
  redis: Redis,
  queueName: string,
  config?: Partial<StreamQueueAdapterConfig>
): StreamQueueAdapter {
  const streams = new ValkeyStreams(redis, config?.streamName ?? DEFAULT_CONFIG.streamName)
  const workQueue = new CoordinationWorkQueue(
    streams,
    redis,
    {
      ...DEFAULT_CONFIG,
      ...config,
      streamName: config?.streamName ?? DEFAULT_CONFIG.streamName,
      consumerGroup: config?.consumerGroup ?? DEFAULT_CONFIG.consumerGroup,
    },
    CoordinationWorkQueue.generateConsumerId(config?.consumerPrefix ?? DEFAULT_CONFIG.consumerPrefix)
  )
  
  return new StreamQueueAdapter(workQueue, queueName, config)
}

/**
 * Create a stream queue adapter with full configuration.
 */
export function createStreamQueueAdapterWith(
  workQueue: CoordinationWorkQueue,
  queueName: string,
  config?: Partial<StreamQueueAdapterConfig>
): StreamQueueAdapter {
  return new StreamQueueAdapter(workQueue, queueName, config)
}

