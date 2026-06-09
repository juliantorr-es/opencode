/**
 * IPC channel registry — single source of truth for all Electron IPC channel names.
 *
 * Groups:
 *   IPC.handle  — ipcMain.handle / ipcRenderer.invoke (two-way RPC)
 *   IPC.send    — ipcRenderer.send / ipcMain.on (fire-and-forget, renderer → main)
 *   IPC.push    — webContents.send / ipcRenderer.on (push, main → renderer)
 *   IPC.store   — electron-store namespace keys
 */

export const IPC = {
  handle: {
    KILL_SIDECAR: "tribunus:kill-sidecar",
    AWAIT_INITIALIZATION: "tribunus:await-initialization",
    SIDECAR_STATUS: "tribunus:sidecar-status",
    RESTART_SIDECAR: "tribunus:restart-sidecar",
    GET_WINDOW_CONFIG: "tribunus:get-window-config",
    CONSUME_INITIAL_DEEP_LINKS: "tribunus:consume-initial-deep-links",
    GET_DEFAULT_SERVER_URL: "tribunus:get-default-server-url",
    SET_DEFAULT_SERVER_URL: "tribunus:set-default-server-url",
    GET_WSL_CONFIG: "tribunus:get-wsl-config",
    SET_WSL_CONFIG: "tribunus:set-wsl-config",
    GET_DISPLAY_BACKEND: "tribunus:get-display-backend",
    SET_DISPLAY_BACKEND: "tribunus:set-display-backend",
    PARSE_MARKDOWN: "tribunus:parse-markdown",
    CHECK_APP_EXISTS: "tribunus:check-app-exists",
    WSL_PATH: "tribunus:wsl-path",
    RESOLVE_APP_PATH: "tribunus:resolve-app-path",
    STORE_GET: "tribunus:store-get",
    STORE_SET: "tribunus:store-set",
    STORE_DELETE: "tribunus:store-delete",
    STORE_CLEAR: "tribunus:store-clear",
    STORE_KEYS: "tribunus:store-keys",
    STORE_LENGTH: "tribunus:store-length",
    OPEN_DIRECTORY_PICKER: "tribunus:open-directory-picker",
    OPEN_FILE_PICKER: "tribunus:open-file-picker",
    SAVE_FILE_PICKER: "tribunus:save-file-picker",
    OPEN_PATH: "tribunus:open-path",
    READ_CLIPBOARD_IMAGE: "tribunus:read-clipboard-image",
    GET_WINDOW_COUNT: "tribunus:get-window-count",
    GET_WINDOW_FOCUSED: "tribunus:get-window-focused",
    SET_WINDOW_FOCUS: "tribunus:set-window-focus",
    SHOW_WINDOW: "tribunus:show-window",
    GET_ZOOM_FACTOR: "tribunus:get-zoom-factor",
    SET_ZOOM_FACTOR: "tribunus:set-zoom-factor",
    GET_PINCH_ZOOM_ENABLED: "tribunus:get-pinch-zoom-enabled",
    SET_PINCH_ZOOM_ENABLED: "tribunus:set-pinch-zoom-enabled",
    SET_TITLEBAR: "tribunus:set-titlebar",
    RUN_DESKTOP_MENU_ACTION: "tribunus:run-desktop-menu-action",
    RUN_UPDATER: "tribunus:run-updater",
    CHECK_UPDATE: "tribunus:check-update",
    INSTALL_UPDATE: "tribunus:install-update",
    SET_BACKGROUND_COLOR: "tribunus:set-background-color",
    EXPORT_DEBUG_LOGS: "tribunus:export-debug-logs",
    RECORD_FATAL_RENDERER_ERROR: "tribunus:record-fatal-renderer-error",
    GET_DESKTOP_PLUGIN_CONFIG: "tribunus:get-desktop-plugin-config",
    SET_DESKTOP_PLUGIN_CONFIG: "tribunus:set-desktop-plugin-config",
    GET_DESKTOP_CUSTOM_AGENTS: "tribunus:get-desktop-custom-agents",
    SET_DESKTOP_CUSTOM_AGENTS: "tribunus:set-desktop-custom-agents",
    DELETE_DESKTOP_CUSTOM_AGENT: "tribunus:delete-desktop-custom-agent",
    GET_DESKTOP_MCP_SERVERS: "tribunus:get-desktop-mcp-servers",
    SET_DESKTOP_MCP_SERVERS: "tribunus:set-desktop-mcp-servers",
    GITHUB_OAUTH_START: "tribunus:github-oauth-start",
    GITHUB_OAUTH_CALLBACK: "tribunus:github-oauth-callback",
    GITHUB_GET_TOKEN: "tribunus:github-get-token",
    GITHUB_SET_TOKEN: "tribunus:github-set-token",
    GITHUB_CLEAR_TOKEN: "tribunus:github-clear-token",
    GITHUB_API_PROXY: "tribunus:github-api-proxy",
    SESSION_EXPORT_DATA: "tribunus:session-export-data",
    SESSION_IMPORT_FILE: "tribunus:session-import-file",
    SET_LOCALE_PREFERENCE: "tribunus:set-locale-preference",
    GET_LOCALE_PREFERENCE: "tribunus:get-locale-preference",
    PLUGIN_INVOKE: "tribunus:plugin:invoke",
    GET_CAPABILITIES: "tribunus:get-capabilities",
    GET_GIT_STATUS: "tribunus:get-git-status",
    GET_SAFE_MODE_DIAGNOSTICS: "tribunus:get-safe-mode-diagnostics",
    SAFE_MODE_ACTION: "tribunus:safe-mode-action",
    OPEN_PROJECT: "tribunus:open-project",
    // ── Secrets ────────────────────────────────────────────
    SECRETS_SET: "tribunus:secrets-set",
    SECRETS_GET: "tribunus:secrets-get",
    SECRETS_DELETE: "tribunus:secrets-delete",
    SECRETS_LIST: "tribunus:secrets-list",
    SECRETS_STATUS: "tribunus:secrets-status",
    // ── Notifications ──────────────────────────────────────
    NOTIFICATIONS_NOTIFY: "tribunus:notifications-notify",
    NOTIFICATIONS_STATUS: "tribunus:notifications-status",
    NOTIFICATIONS_SET_PREFERENCES: "tribunus:notifications-set-preferences",
  } as const,

  send: {
    OPEN_LINK: "tribunus:open-link",
    SHOW_NOTIFICATION: "tribunus:show-notification",
    RELAUNCH: "tribunus:relaunch",
    LOADING_WINDOW_COMPLETE: "tribunus:loading-window-complete",
    PLUGIN_SEND: "tribunus:plugin:send",
    RENDERER_READY: "tribunus:renderer-ready",
    // ── System Status ───────────────────────────────────────
    SYSTEM_STATUS: "tribunus:system-status",
  } as const,
  push: {
    INIT_STEP: "tribunus:init-step",
    STORAGE_MIGRATION_PROGRESS: "tribunus:storage-migration-progress",
    MENU_COMMAND: "tribunus:menu-command",
    DEEP_LINK: "tribunus:deep-link",
    PINCH_ZOOM_ENABLED_CHANGED: "tribunus:pinch-zoom-enabled-changed",
    ZOOM_FACTOR_CHANGED: "tribunus:zoom-factor-changed",
    PLUGIN_PUSH: "tribunus:plugin:push",
  } as const,

  store: {
    SETTINGS: "settings",
    DESKTOP_CUSTOM_AGENTS: "desktop-custom-agents",
    DESKTOP_MCP_SERVERS: "desktop-mcp-servers",
    DESKTOP_PLUGIN_CONFIG: "desktop-plugin-config",
    GITHUB_AUTH: "github-auth",
  } as const,
}

export type IpcHandle = (typeof IPC.handle)[keyof typeof IPC.handle]
export type IpcSend = (typeof IPC.send)[keyof typeof IPC.send]
export type IpcPush = (typeof IPC.push)[keyof typeof IPC.push]
export type IpcStore = (typeof IPC.store)[keyof typeof IPC.store]
