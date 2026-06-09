import * as S from "../schema-compat"
import type { IpcMethodContract } from "../registry"

// ── Shared schemas ──

const SidecarStatusSchema = S.Struct({
  ready: S.Bool,
  pid: S.Nullable(S.Num),
  url: S.Nullable(S.Str),
  mode: S.Lits(["ephemeral", "persistent"]),
  lastError: S.Nullable(S.Str),
})

const ServerReadyDataSchema = S.Struct({
  url: S.Str,
  password: S.Optional(S.Str),
})

const WindowConfigSchema = S.Struct({
  updaterEnabled: S.Bool,
})

const WslConfigSchema = S.Struct({
  enabled: S.Bool,
})

const FatalRendererErrorSchema = S.Struct({
  message: S.Str,
  stack: S.Optional(S.Str),
  component: S.Optional(S.Str),
})

const SafeModeDiagnosticsSchema = S.Unknown
const SafeModeActionSchema = S.Str

// ── Parameter schemas ──

const NoneParams = S.Tuple([])
const NullableStrParam = S.Tuple([S.Nullable(S.Str)])
const StrParam = S.Tuple([S.Str])
const BoolParam = S.Tuple([S.Bool])
const WslPathParams = S.Tuple([S.Str, S.Nullable(S.Str)])
const WslConfigParams = S.Tuple([WslConfigSchema])
const FatalRendererErrorParams = S.Tuple([FatalRendererErrorSchema])
const SafeModeActionParams = S.Tuple([SafeModeActionSchema])

// ── Success schemas ──

const VoidSuccess = S.UndefinedConst
const CheckUpdateSuccess = S.Struct({
  updateAvailable: S.Bool,
  version: S.Optional(S.Str),
})

// ── Common contract fields ──

const category = "init" as const
const timeoutStandard = "standard" as const
const timeoutLong = "long" as const
const sensitivityInternal = "internal" as const
const sensitivityAuthority = "authority" as const
const senderStandard = "standard" as const
const senderStrict = "strict" as const
const errors = ["invalid_request", "permission_denied", "unavailable", "internal"] as const

// ── Contracts ──

export const contracts: readonly IpcMethodContract[] = [
  {
    channel: "tribunus:kill-sidecar",
    method: "init.killSidecar",
    params: NoneParams,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStrict,
    errors,
    description: "Kill the running sidecar process",
  },
  {
    channel: "tribunus:sidecar-status",
    method: "init.sidecarStatus",
    params: NoneParams,
    success: SidecarStatusSchema,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get the current sidecar status (ready, pid, url, mode, lastError)",
  },
  {
    channel: "tribunus:restart-sidecar",
    method: "init.restartSidecar",
    params: NoneParams,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStrict,
    errors,
    description: "Restart the sidecar process",
  },
  {
    channel: "tribunus:await-initialization",
    method: "init.awaitInitialization",
    params: NoneParams,
    success: ServerReadyDataSchema,
    category,
    timeout: timeoutLong,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Await full application initialization, returning the server URL",
  },
  {
    channel: "tribunus:get-window-config",
    method: "init.getWindowConfig",
    params: NoneParams,
    success: WindowConfigSchema,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get the window configuration",
  },
  {
    channel: "tribunus:consume-initial-deep-links",
    method: "init.consumeInitialDeepLinks",
    params: NoneParams,
    success: S.Arr(S.Str),
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Consume and return any initial deep links that launched the app",
  },
  {
    channel: "tribunus:get-default-server-url",
    method: "init.getDefaultServerUrl",
    params: NoneParams,
    success: S.Nullable(S.Str),
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get the default server URL, or null if not set",
  },
  {
    channel: "tribunus:set-default-server-url",
    method: "init.setDefaultServerUrl",
    params: NullableStrParam,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStandard,
    errors,
    description: "Set the default server URL (null to clear)",
  },
  {
    channel: "tribunus:get-wsl-config",
    method: "init.getWslConfig",
    params: NoneParams,
    success: WslConfigSchema,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get the current WSL configuration",
  },
  {
    channel: "tribunus:set-wsl-config",
    method: "init.setWslConfig",
    params: WslConfigParams,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStandard,
    errors,
    description: "Set the WSL configuration",
  },
  {
    channel: "tribunus:get-display-backend",
    method: "init.getDisplayBackend",
    params: NoneParams,
    success: S.Nullable(S.Str),
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get the current display backend, or null if not set",
  },
  {
    channel: "tribunus:set-display-backend",
    method: "init.setDisplayBackend",
    params: NullableStrParam,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStandard,
    errors,
    description: "Set the display backend (null to clear)",
  },
  {
    channel: "tribunus:parse-markdown",
    method: "init.parseMarkdown",
    params: StrParam,
    success: S.Str,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Parse markdown text and return rendered HTML",
  },
  {
    channel: "tribunus:check-app-exists",
    method: "init.checkAppExists",
    params: StrParam,
    success: S.Bool,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Check whether an application exists on the system by name",
  },
  {
    channel: "tribunus:wsl-path",
    method: "init.wslPath",
    params: WslPathParams,
    success: S.Str,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Convert a Windows path to a WSL path, with optional mode",
  },
  {
    channel: "tribunus:resolve-app-path",
    method: "init.resolveAppPath",
    params: StrParam,
    success: S.Nullable(S.Str),
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Resolve the full filesystem path for an application by name",
  },
  {
    channel: "tribunus:run-updater",
    method: "init.runUpdater",
    params: BoolParam,
    success: VoidSuccess,
    category,
    timeout: timeoutLong,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStrict,
    errors,
    description: "Run the application updater; if alertOnFail is true, show error UI on failure",
  },
  {
    channel: "tribunus:check-update",
    method: "init.checkUpdate",
    params: NoneParams,
    success: CheckUpdateSuccess,
    category,
    timeout: timeoutLong,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Check for available updates; returns whether one exists and the version string",
  },
  {
    channel: "tribunus:install-update",
    method: "init.installUpdate",
    params: NoneParams,
    success: VoidSuccess,
    category,
    timeout: timeoutLong,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStrict,
    errors,
    description: "Install the available update",
  },
  {
    channel: "tribunus:set-background-color",
    method: "init.setBackgroundColor",
    params: StrParam,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStandard,
    errors,
    description: "Set the application background color",
  },
  {
    channel: "tribunus:export-debug-logs",
    method: "init.exportDebugLogs",
    params: NoneParams,
    success: S.Str,
    category,
    timeout: timeoutLong,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Export debug logs as a string",
  },
  {
    channel: "tribunus:record-fatal-renderer-error",
    method: "init.recordFatalRendererError",
    params: FatalRendererErrorParams,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Record a fatal renderer error with message, optional stack, and component info",
  },
  {
    channel: "tribunus:get-safe-mode-diagnostics",
    method: "init.getSafeModeDiagnostics",
    params: NoneParams,
    success: SafeModeDiagnosticsSchema,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityInternal,
    senderPolicy: senderStandard,
    errors,
    description: "Get safe mode diagnostics data",
  },
  {
    channel: "tribunus:safe-mode-action",
    method: "init.safeModeAction",
    params: SafeModeActionParams,
    success: VoidSuccess,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStandard,
    errors,
    description: "Perform a safe mode action",
  },
  {
    channel: "tribunus:open-project",
    method: "init.openProject",
    params: StrParam,
    success: S.Str,
    category,
    timeout: timeoutStandard,
    sensitivity: sensitivityAuthority,
    senderPolicy: senderStrict,
    errors,
    description: "Open a project by directory path; returns the project ID",
  },
]
