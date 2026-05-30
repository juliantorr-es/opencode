import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ClaimInfo = Schema.Struct({
  taskId: Schema.String,
  sessionId: Schema.String,
  wave: Schema.Number,
  waveType: Schema.String,
  subagentType: Schema.String,
  description: Schema.String,
  status: Schema.String,
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  releasedAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "ClaimInfo" })

export const ReservationInfo = Schema.Struct({
  path: Schema.String,
  taskId: Schema.String,
  sessionId: Schema.String,
  status: Schema.String,
  createdAt: Schema.Number,
}).annotate({ identifier: "ReservationInfo" })

export const ClaimsQuery = Schema.Struct({
  sessionId: Schema.optional(Schema.String).annotate({
    description: "Filter claims by session ID",
  }),
  status: Schema.optional(Schema.String).annotate({
    description: "Filter claims by status (claimed|released|failed)",
  }),
}).annotate({ identifier: "ClaimsQuery" })

const root = "/api/claims"

export const ClaimsApi = HttpApi.make("claims")
  .add(
    HttpApiGroup.make("claims")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: ClaimsQuery,
          success: Schema.Struct({
            claims: Schema.Array(ClaimInfo),
            reservations: Schema.Array(ReservationInfo),
          }).annotate({ identifier: "ClaimsResponse" }),
          error: Schema.Void,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "claims.list",
            summary: "List coordination claims and path reservations",
            description:
              "Returns all active coordination claims and path reservations. " +
              "Optionally filter by sessionId to scope to a specific session.",
          }),
        ),
        HttpApiEndpoint.get("tree", `${root}/tree`, {
          query: Schema.Struct({
            sessionId: Schema.optional(Schema.String).annotate({
              description: "Scope tree to a specific session",
            }),
          }).annotate({ identifier: "ClaimsTreeQuery" }),
          success: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                name: Schema.String,
                type: Schema.Literal("file", "directory"),
                status: Schema.String,
                claim: Schema.optional(ClaimInfo),
                children: Schema.optional(
                  Schema.Array(Schema.Struct({
                    path: Schema.String,
                    name: Schema.String,
                    type: Schema.Literal("file", "directory"),
                    status: Schema.String,
                    claim: Schema.optional(ClaimInfo),
                  })),
                ),
              }),
            ),
          }).annotate({ identifier: "ClaimsTreeResponse" }),
          error: Schema.Void,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "claims.tree",
            summary: "Get claims organized as a file tree",
            description:
              "Returns claims organized by file path into a directory-tree structure " +
              "suitable for rendering the Claims Map visualization.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "claims",
          description: "Coordination claims and path reservation queries.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Claims API",
      version: "0.0.1",
      description: "API for querying coordination claims and reservations.",
    }),
  )
