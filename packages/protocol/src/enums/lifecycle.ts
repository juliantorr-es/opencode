// Project lifecycle states
export const ProjectState = {
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
} as const
export type ProjectState = (typeof ProjectState)[keyof typeof ProjectState]

// Session lifecycle states
export const SessionState = {
  CREATED: "created",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  TERMINATED: "terminated",
} as const
export type SessionState = (typeof SessionState)[keyof typeof SessionState]

// Work item lifecycle states
export const WorkItemState = {
  PENDING: "pending",
  CLAIMED: "claimed",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTERED: "dead_lettered",
  RETRYABLE: "retryable",
} as const
export type WorkItemState = (typeof WorkItemState)[keyof typeof WorkItemState]

// Gate lifecycle states
export const GateState = {
  PENDING: "pending",
  EVALUATING: "evaluating",
  PASSED: "passed",
  FAILED: "failed",
  OVERRIDDEN: "overridden",
} as const
export type GateState = (typeof GateState)[keyof typeof GateState]

// Campaign states
export const CampaignState = {
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
} as const
export type CampaignState = (typeof CampaignState)[keyof typeof CampaignState]

// Mission states
export const MissionState = {
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
} as const
export type MissionState = (typeof MissionState)[keyof typeof MissionState]

// Lane states
export const LaneState = {
  IDLE: "idle",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
} as const
export type LaneState = (typeof LaneState)[keyof typeof LaneState]

// Task states
export const TaskState = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const
export type TaskState = (typeof TaskState)[keyof typeof TaskState]
