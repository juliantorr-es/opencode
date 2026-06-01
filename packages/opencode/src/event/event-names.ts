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
  SessionCheckpoint: 'session.checkpoint',
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

  // project_map.*
  ProjectMapInvalidated: 'project_map.invalidated',

  // mcp.*
  McpToolsChanged: 'mcp.tools.changed',
  McpStatusChanged: 'mcp.status.changed',
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
  InstanceCreated: 'instance.created',
  InstanceLoaded: 'instance.loaded',
  InstanceDegraded: 'instance.degraded',
  InstanceFailed: 'instance.failed',

  // coordination.*
  CoordSubagentPhase: 'coord.subagent.phase',

  // session.next.*
  SessionNextAgentSwitched: 'session.next.agent.switched',
  SessionNextModelSwitched: 'session.next.model.switched',
  SessionNextPrompted: 'session.next.prompted',
  SessionNextSynthetic: 'session.next.synthetic',
  SessionNextShellStarted: 'session.next.shell.started',
  SessionNextShellEnded: 'session.next.shell.ended',
  SessionNextStepStarted: 'session.next.step.started',
  SessionNextStepEnded: 'session.next.step.ended',
  SessionNextStepFailed: 'session.next.step.failed',
  SessionNextTextStarted: 'session.next.text.started',
  SessionNextTextDelta: 'session.next.text.delta',
  SessionNextTextEnded: 'session.next.text.ended',
  SessionNextReasoningStarted: 'session.next.reasoning.started',
  SessionNextReasoningDelta: 'session.next.reasoning.delta',
  SessionNextReasoningEnded: 'session.next.reasoning.ended',
  SessionNextToolInputStarted: 'session.next.tool.input.started',
  SessionNextToolInputDelta: 'session.next.tool.input.delta',
  SessionNextToolInputEnded: 'session.next.tool.input.ended',
  SessionNextToolCalled: 'session.next.tool.called',
  SessionNextToolProgress: 'session.next.tool.progress',
  SessionNextToolSuccess: 'session.next.tool.success',
  SessionNextToolFailed: 'session.next.tool.failed',
  SessionNextRetried: 'session.next.retried',
  SessionNextCompactionStarted: 'session.next.compaction.started',
  SessionNextCompactionDelta: 'session.next.compaction.delta',
  SessionNextCompactionEnded: 'session.next.compaction.ended',

  // workspace.*
  WorkspaceReady: 'workspace.ready',
  WorkspaceFailed: 'workspace.failed',
  WorkspaceStatus: 'workspace.status',

  // worktree.*
  WorktreeReady: 'worktree.ready',
  WorktreeFailed: 'worktree.failed',

  // campaign.*
  CampaignCreated: 'campaign.created',
  CampaignLaneCreated: 'campaign.lane.created',
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
  GatesAllPassed: 'gates.all_passed',

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
  ScopeUnsafe: 'scope.unsafe',

  // child.*
  ChildBlocked: 'child.blocked',
  ChildCompleted: 'child.completed',
  ChildrenAllComplete: 'children.all_complete',
  LaneCompleted: 'lane.completed',
  LaneBlocked: 'lane.blocked',
  LaneReturned: 'lane.returned',
  ClaimConflict: 'claim.conflict',
  ClaimsAcquired: 'claims.acquired',
  ToolFailed: 'tool.failed',
  UserApproval: 'user.approval',
  RedteamCompleted: 'redteam.completed',
  RedteamFinding: 'redteam.finding',
  RedteamFindingRecorded: 'redteam.finding.recorded',
  FindingBlocking: 'finding.blocking',
  FindingConfirmed: 'finding.confirmed',
} as const

/** Union type of all canonical event type strings. */
export type EventName = (typeof EventName)[keyof typeof EventName]

/** Array of all EventName values for runtime validation. */
export const EventNameValues: readonly EventName[] = Object.values(EventName) as EventName[]
