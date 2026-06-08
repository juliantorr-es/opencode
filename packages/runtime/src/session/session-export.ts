import { Effect, Schema, Struct, Types } from "effect"
import { Permission } from "@/permission"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"
import { Info } from "./session"
import { Service as SessionService } from "./session"
import { MessageV2 } from "./message-v2"

/**
 * ExportInfo: a subset of Session.Info without permission, share.url, or path.
 * This is what gets serialized for export/import.
 */
export const ExportInfo = Schema.Struct(
  Struct.omit(Info.fields, ["permission", "share", "path"]),
)
export type ExportInfo = Types.DeepMutable<Schema.Schema.Type<typeof ExportInfo>>

export const ExportedSession = Schema.Struct({
  version: Schema.Literal("1"),
  exportedAt: Schema.Finite,
  sanitized: Schema.Boolean,
  session: ExportInfo,
  messages: Schema.Array(MessageV2.WithParts),
})
export type ExportedSession = Types.DeepMutable<Schema.Schema.Type<typeof ExportedSession>>

/**
 * Sanitize a session Info by removing permission, share.url, and path fields.
 * Returns a structured clone with those fields stripped.
 */
export function sanitizeSession(info: Info): ExportInfo {
  return {
    id: info.id,
    slug: info.slug,
    projectID: info.projectID,
    workspaceID: info.workspaceID,
    directory: info.directory,
    parentID: info.parentID,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    summary: info.summary,
    cost: info.cost,
    tokens: info.tokens,
    time: info.time,
    revert: info.revert,
  }
}

/**
 * Export a session — fetch info + messages, wrap in ExportedSession schema.
 */
export const exportSession = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const session = yield* SessionService
    const info = yield* session.get(sessionID)
    const messages = yield* session.messages({ sessionID })
    return {
      version: "1" as const,
      exportedAt: Date.now(),
      sanitized: true,
      session: sanitizeSession(info),
      messages,
    }
  })

/**
 * Import a session from an ExportedSession payload.
 * Bypasses InstanceState.context by using the importCreate method
 * that accepts explicit projectID/directory.
 * Re-IDs all messages and parts to avoid collisions.
 */
export const importSession = (data: ExportedSession) =>
  Effect.gen(function* () {
    const session = yield* SessionService

    // Create the session with explicit projectID/directory — no InstanceState needed
    // Use type assertion for fields that may not exist on ExportInfo (permission, share, path)
    const raw = data.session as Record<string, unknown>
    const imported = yield* session.importCreate({
      projectID: data.session.projectID,
      directory: data.session.directory,
      title: data.session.title,
      path: (raw.path as string | undefined),
      workspaceID: data.session.workspaceID,
      agent: data.session.agent,
      model: data.session.model as any,
      permission: !data.sanitized ? (raw.permission as any) : undefined,
      time: data.session.time,
    })

    // Remap old message IDs to new ones
    const idMap = new Map<string, MessageID>()

    for (const msg of data.messages) {
      const newID = MessageID.ascending()
      idMap.set(msg.info.id, newID)

      const parentID =
        msg.info.role === "assistant" && msg.info.parentID
          ? idMap.get(msg.info.parentID)
          : undefined

      yield* session.updateMessage({
        ...(msg.info as any),
        sessionID: imported.id,
        id: newID,
        parentID,
      })

      for (const part of msg.parts) {
        yield* session.updatePart({
          ...(part as any),
          id: PartID.ascending(),
          messageID: newID,
          sessionID: imported.id,
        })
      }
    }

    return imported
  })
