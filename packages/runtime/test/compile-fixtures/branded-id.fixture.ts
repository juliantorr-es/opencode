/**
 * Compile fixture: proves branded ID constructor patterns.
 * This file MUST compile with `tsgo --noEmit`.
 */
import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"
import type { TaskID } from "@/runtime/supervision"
import type { WorkspaceID } from "@/runtime/workspace-lifecycle"

// ============================================================
// Proven pattern: Branded IDs require explicit construction.
// The `string & Brand<"X">` intersection means plain strings
// do NOT satisfy the type. A constructor is required.
// ============================================================

// SAFE: constructor that performs validation
declare function makeSessionID(raw: string): SessionID

const validSession: SessionID = makeSessionID("abc-123")

// PROVEN: plain string fails (this is the type safety we want)
// @ts-expect-error — intentional: plain string should not satisfy SessionID
const _badSession: SessionID = "plain-string"

// UNSAFE constructor for tests (no validation, explicit about risk)
declare function makeSessionIDUnsafe(raw: string): SessionID
const testSession: SessionID = makeSessionIDUnsafe("test-session")

// Same pattern for other branded IDs
declare function makeProjectID(raw: string): ProjectID
declare function makeProjectIDUnsafe(raw: string): ProjectID
declare function makeTaskID(raw: string): TaskID
declare function makeTaskIDUnsafe(raw: string): TaskID
declare function makeWorkspaceID(raw: string): WorkspaceID
declare function makeWorkspaceIDUnsafe(raw: string): WorkspaceID

const _proj: ProjectID = makeProjectID("proj-1")
const _task: TaskID = makeTaskID("task-1")
const _ws: WorkspaceID = makeWorkspaceID("ws-1")
