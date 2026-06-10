import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"
import type { TaskID } from "@/runtime/supervision"
import type { WorkspaceID } from "@/runtime/workspace-lifecycle"

// Safe constructors (validated at boundaries where strings enter the system)
// For now, delegate to unsafe until Schema validation is wired in.

export function makeSessionID(raw: string): SessionID { return raw as SessionID }
export function makeProjectID(raw: string): ProjectID { return raw as ProjectID }
export function makeTaskID(raw: string): TaskID { return raw as TaskID }
export function makeWorkspaceID(raw: string): WorkspaceID { return raw as WorkspaceID }

// Unsafe constructors — explicit about bypassing validation, for tests and trusted internal paths
export function makeSessionIDUnsafe(raw: string): SessionID { return raw as SessionID }
export function makeProjectIDUnsafe(raw: string): ProjectID { return raw as ProjectID }
export function makeTaskIDUnsafe(raw: string): TaskID { return raw as TaskID }
export function makeWorkspaceIDUnsafe(raw: string): WorkspaceID { return raw as WorkspaceID }
