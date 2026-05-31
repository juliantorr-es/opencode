// ════════════════════════════════════════════════
// EventName — canonical event type registry
//
// Every BusEvent.define() call MUST use a value from
// this registry. Add new events here first.
// This module is a LEAF — it imports NOTHING from
// any module that defines events.
// ════════════════════════════════════════════════

/** All canonical event type strings, keyed by PascalCase domain.Verb constant names. */
export const EventName = {
  // session.*
  SessionCreated: 'session.created',
  SessionUpdated: 'session.updated',
  SessionDeleted: 'session.deleted',
  SessionDiff: 'session.diff',
  SessionError: 'session.error',
  SessionStatus: 'session.status',
  SessionIdle: 'session.idle', // # deprecated — remove in Phase 4
  SessionCompacted: 'session.compacted',
  MessagePartDelta: 'message.part.delta',
  MessageUpdated: 'message.updated',
  MessageRemoved: 'message.removed',
  MessagePartUpdated: 'message.part.updated',
  MessagePartRemoved: 'message.part.removed',
  TodoUpdated: 'todo.updated',

  // permission.*
  PermissionAsked: 'permission.asked',
  PermissionReplied: 'permission.replied',
  PermissionDenied: 'permission.denied',

  // question.*
  QuestionAsked: 'question.asked',
  QuestionReplied: 'question.replied',
  QuestionRejected: 'question.rejected',

  // command.*
  CommandExecuted: 'command.executed',

  // file.*
  FileEdited: 'file.edited',
  FileConflict: 'file.conflict',
  FileRead: 'file.read',
  FileWatcherUpdated: 'file.watcher.updated',

  // project.*
  ProjectUpdated: 'project.updated',
  VcsBranchUpdated: 'vcs.branch.updated',

  // mcp.*
  McpToolsChanged: 'mcp.tools.changed',
  McpBrowserOpenFailed: 'mcp.browser.open.failed',

  // pty.*
  PtyCreated: 'pty.created',
  PtyUpdated: 'pty.updated',
  PtyExited: 'pty.exited',
  PtyDeleted: 'pty.deleted',

  // lsp.*
  LspDiagnostics: 'lsp.diagnostics',
  LspClientDiagnostics: 'lsp.client.diagnostics',
  LspUpdated: 'lsp.updated',

  // installation.*
  InstallationUpdated: 'installation.updated',
  InstallationUpdateAvailable: 'installation.update-available',

  // ide.*
  IdeInstalled: 'ide.installed',

  // server.*
  ServerConnected: 'server.connected',
  GlobalDisposed: 'global.disposed',
  ServerInstanceDisposed: 'server.instance.disposed',

  // coordination.*
  CoordSubagentPhase: 'coord.subagent.phase',

  // session.next.*
  SessionNextAgentSwitched: 'session.next.agent.switched',
  SessionNextModelSwitched: 'session.next.model.switched',
  SessionNextPrompted: 'session.next.prompted',
  SessionNextSynthetic: 'session.next.synthetic',

  // workspace.*
  WorkspaceReady: 'workspace.ready',
  WorkspaceFailed: 'workspace.failed',
  WorkspaceStatus: 'workspace.status',

  // worktree.*
  WorktreeReady: 'worktree.ready',
  WorktreeFailed: 'worktree.failed',

  // campaign.*
  CampaignCreated: 'campaign.created',
  CampaignLaneCreated: 'lane.created',
  CampaignLaneAssigned: 'campaign.lane.assigned',
  CampaignLaneCompleted: 'campaign.lane.completed',
  CampaignGateActivated: 'campaign.gate.activated',
  CampaignGatePassed: 'campaign.gate.passed',
  CampaignGateFailed: 'campaign.gate.failed',
  CampaignArtifactProduced: 'campaign.artifact.produced',
  CampaignReviewInitiated: 'campaign.review.initiated',
  CampaignReviewCompleted: 'campaign.review.completed',
  CampaignPushInitiated: 'campaign.push.initiated',
  CampaignPushCompleted: 'campaign.push.completed',
  CampaignPushFailed: 'campaign.push.failed',
  CampaignPushEvidenceCollected: 'campaign.push.evidence.collected',
  CampaignPushEvidenceMissing: 'campaign.push.evidence.missing',
  CampaignPublicationSubmitted: 'campaign.publication.submitted',
  CampaignPublicationAdmitted: 'campaign.publication.admitted',
  CampaignPublicationBlocked: 'campaign.publication.blocked',
  CampaignCheckpointCreated: 'campaign.checkpoint.created',

  // context.*
  ContextSufficient: 'context.sufficient',

  // plan.*
  PlanProduced: 'plan.produced',
  PlanApproved: 'plan.approved',
  PlanRejected: 'plan.rejected',
  PlanCreated: 'plan.created',
  ArtifactPlan: 'artifact.plan',
  CriticReview: 'critic.review',

  // edit.*
  EditApplied: 'edit.applied',

  // validation.*
  ValidationCompleted: 'validation.completed',
  ValidationFailure: 'validation.failure',

  // scout.*
  ScoutCompleted: 'scout.completed',

  // scope.*
  ScopeSynthesized: 'scope.synthesized',

  // child.*
  ChildBlocked: 'child.blocked',
  ChildCompleted: 'child.completed',
  LaneCompleted: 'lane.completed',
  LaneBlocked: 'lane.blocked',
  ClaimConflict: 'claim.conflict',
  ToolFailed: 'tool.failed',
  UserApproval: 'user.approval',
  RedteamFinding: 'redteam.finding',
} as const

/** Union type of all canonical event type strings. */
export type EventName = (typeof EventName)[keyof typeof EventName]

/** Array of all EventName values for runtime validation. */
export const EventNameValues: readonly EventName[] = Object.values(EventName) as EventName[]
