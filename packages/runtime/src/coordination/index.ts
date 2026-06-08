/**
 * Coordination Module Index
 * 
 * This module provides the Valkey Stream-Backed Coordination Kernel v1.
 * 
 * Doctrine:
 * - Valkey decides who is currently responsible for work
 * - PGlite records what actually happened
 * - Valkey may be wiped and rebuilt
 * - PGlite may NOT be treated as a cache
 * - No task is complete because Valkey says so
 * 
 * Architecture:
 * - CoordinationWorkQueue: High-level work queue abstraction (use this)
 * - ValkeyStreams: Low-level stream primitives
 * - ValkeySortedSets: Low-level sorted set primitives for scheduling
 * - fabric.ts: CoordinationFabric interface and implementations
 * - valkey-fabric.ts: Valkey-based fabric implementation
 * - local-fabric.ts: In-memory fabric for testing/local mode
 * - recovery.ts: Recovery protocols and state management
 */

export {
  // High-level API (use this for most runtime code)
  CoordinationWorkQueue,
  workQueueLayer,
  DEFAULT_CONFIG,
  DEFAULT_STREAM_NAME,
  DEFAULT_CONSUMER_GROUP,
  DEFAULT_PENDING_IDLE_MS,
} from "./work-queue"

export type {
  WorkQueueConfig,
  WorkItemId,
  WorkEnvelope,
  QueuedWork,
  WorkClaim,
  TerminalResultKind,
  RetryableResult,
  TerminalResult,
  WorkResult,
  CompletionReceipt,
  ConsumerIdentity,
} from "./work-queue"

// Low-level primitives (use sparingly - prefer high-level API)
export {
  ValkeyStreams,
  createValkeyStreams,
  createValkeyStreamsFor,
} from "./stream-primitives"

export type {
  StreamEntry,
  StreamGroupInfo,
  PendingEntry,
  ClaimedEntry,
  StreamInfo,
} from "./stream-primitives"

export {
  ValkeySortedSets,
  createValkeySortedSets,
  DEFAULT_DUE_SET_NAME,
  DEFAULT_PRIORITY_SET_NAME,
} from "./sorted-set-primitives"

export type {
  SortedSetEntry,
  SortedSetRangeOptions,
  SortedSetRangeResult,
} from "./sorted-set-primitives"

// Scheduler
export {
  WorkScheduler,
  createWorkScheduler,
  createWorkSchedulerWith,
  DEFAULT_SCHEDULER_CONFIG,
} from "./scheduler"

export type {
  SchedulerConfig,
  ScheduledWork,
  SchedulerMetrics,
  ScheduleRetryOptions,
  ScheduleOptions,
} from "./scheduler"

// Observability
export {
  CoordinationObservability,
  createObservability,
  createObservabilityWith,
  DEFAULT_OBSERVABILITY_CONFIG,
} from "./observability"

export type {
  StreamMetrics,
  SortedSetMetrics,
  WorkQueueMetrics,
  PendingEntryInfo,
  WorkItemInspection,
  ObservabilityConfig,
} from "./observability"

// Stream Queue Adapter (for migration from LPUSH/RPUSH)
export {
  StreamQueueAdapter,
  createStreamQueueAdapter,
  createStreamQueueAdapterWith,
  DEFAULT_ADAPTER_CONFIG,
} from "./stream-queue-adapter"

export type {
  StreamQueueAdapterConfig,
} from "./stream-queue-adapter"

// Fabric interface and implementations
export {
  CoordinationFabric,
  createFabric,
  VALKEY_ENABLED,
  isValkeyBinaryAvailable,
  AgentHeartbeat,
  LeaseRequest,
  LeaseResult,
  CoordinationEvent,
  CoordinationJob,
  BackpressureState,
} from "./fabric"

export { createValkeyFabric } from "./valkey-fabric"

export { createLocalFabric } from "./local-fabric"

// Recovery
export {
  CoordinationRecovery,
  recoveryLayer,
  DEFAULT_RECOVERY_CONFIG,
  planCoordinationRecovery,
  persistCoordinationRecoveryReceipt,
  setRecoveryStatus,
  getRecoveryStatus,
} from "./recovery"

export type {
  CoordinationRecoveryState,
  RecoveryOutcome,
  RecoveryReceipt,
  RecoveryPlan,
  RecoveryConfig,
  RebuildStats,
  RebuildReceipt,
} from "./recovery"

// Database schema
export {
  WorkItemTable,
  WorkAttemptTable,
  DeadLetterTable,
  RecoveryReceiptTable,
  ScheduledWorkTable,
  StreamStateTable,
} from "./work-queue.pg.sql"

export type {
  WorkItemStatus,
  WorkStatus,
  DeadLetterReason,
  RecoveryAction,
} from "./work-queue.pg.sql"
