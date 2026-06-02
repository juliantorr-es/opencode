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
    KILL_SIDECAR: "opencode:kill-sidecar",
    AWAIT_INITIALIZATION: "opencode:await-initialization",
    GET_WINDOW_CONFIG: "opencode:get-window-config",
    CONSUME_INITIAL_DEEP_LINKS: "opencode:consume-initial-deep-links",
    GET_DEFAULT_SERVER_URL: "opencode:get-default-server-url",
    SET_DEFAULT_SERVER_URL: "opencode:set-default-server-url",
    GET_WSL_CONFIG: "opencode:get-wsl-config",
    SET_WSL_CONFIG: "opencode:set-wsl-config",
    GET_DISPLAY_BACKEND: "opencode:get-display-backend",
    SET_DISPLAY_BACKEND: "opencode:set-display-backend",
    PARSE_MARKDOWN: "opencode:parse-markdown",
    CHECK_APP_EXISTS: "opencode:check-app-exists",
    WSL_PATH: "opencode:wsl-path",
    RESOLVE_APP_PATH: "opencode:resolve-app-path",
    STORE_GET: "opencode:store-get",
    STORE_SET: "opencode:store-set",
    STORE_DELETE: "opencode:store-delete",
    STORE_CLEAR: "opencode:store-clear",
    STORE_KEYS: "opencode:store-keys",
    STORE_LENGTH: "opencode:store-length",
    OPEN_DIRECTORY_PICKER: "opencode:open-directory-picker",
    OPEN_FILE_PICKER: "opencode:open-file-picker",
    SAVE_FILE_PICKER: "opencode:save-file-picker",
    OPEN_PATH: "opencode:open-path",
    READ_CLIPBOARD_IMAGE: "opencode:read-clipboard-image",
    GET_WINDOW_COUNT: "opencode:get-window-count",
    GET_WINDOW_FOCUSED: "opencode:get-window-focused",
    SET_WINDOW_FOCUS: "opencode:set-window-focus",
    SHOW_WINDOW: "opencode:show-window",
    GET_ZOOM_FACTOR: "opencode:get-zoom-factor",
    SET_ZOOM_FACTOR: "opencode:set-zoom-factor",
    GET_PINCH_ZOOM_ENABLED: "opencode:get-pinch-zoom-enabled",
    SET_PINCH_ZOOM_ENABLED: "opencode:set-pinch-zoom-enabled",
    SET_TITLEBAR: "opencode:set-titlebar",
    RUN_DESKTOP_MENU_ACTION: "opencode:run-desktop-menu-action",
    RUN_UPDATER: "opencode:run-updater",
    CHECK_UPDATE: "opencode:check-update",
    INSTALL_UPDATE: "opencode:install-update",
    SET_BACKGROUND_COLOR: "opencode:set-background-color",
    EXPORT_DEBUG_LOGS: "opencode:export-debug-logs",
    RECORD_FATAL_RENDERER_ERROR: "opencode:record-fatal-renderer-error",
    GET_DESKTOP_PLUGIN_CONFIG: "opencode:get-desktop-plugin-config",
    SET_DESKTOP_PLUGIN_CONFIG: "opencode:set-desktop-plugin-config",
    GET_DESKTOP_CUSTOM_AGENTS: "opencode:get-desktop-custom-agents",
    SET_DESKTOP_CUSTOM_AGENTS: "opencode:set-desktop-custom-agents",
    DELETE_DESKTOP_CUSTOM_AGENT: "opencode:delete-desktop-custom-agent",
    GET_DESKTOP_MCP_SERVERS: "opencode:get-desktop-mcp-servers",
    SET_DESKTOP_MCP_SERVERS: "opencode:set-desktop-mcp-servers",
    GITHUB_OAUTH_START: "opencode:github-oauth-start",
    GITHUB_OAUTH_CALLBACK: "opencode:github-oauth-callback",
    GITHUB_GET_TOKEN: "opencode:github-get-token",
    GITHUB_SET_TOKEN: "opencode:github-set-token",
    GITHUB_CLEAR_TOKEN: "opencode:github-clear-token",
    GITHUB_API_PROXY: "opencode:github-api-proxy",
    SESSION_EXPORT_DATA: "opencode:session-export-data",
    SESSION_IMPORT_FILE: "opencode:session-import-file",
    SET_LOCALE_PREFERENCE: "opencode:set-locale-preference",
    GET_LOCALE_PREFERENCE: "opencode:get-locale-preference",
    PLUGIN_INVOKE: "opencode:plugin:invoke",
    GET_CAPABILITIES: "opencode:get-capabilities",
    GET_GIT_STATUS: "opencode:get-git-status",
    GET_SAFE_MODE_DIAGNOSTICS: "opencode:get-safe-mode-diagnostics",
    SAFE_MODE_ACTION: "opencode:safe-mode-action",
    OPEN_PROJECT: "opencode:open-project",
    // ── Secrets ────────────────────────────────────────────
    SECRETS_SET: "opencode:secrets-set",
    SECRETS_GET: "opencode:secrets-get",
    SECRETS_DELETE: "opencode:secrets-delete",
    SECRETS_LIST: "opencode:secrets-list",
    SECRETS_STATUS: "opencode:secrets-status",
    // ── Notifications ──────────────────────────────────────
    NOTIFICATIONS_NOTIFY: "opencode:notifications-notify",
    NOTIFICATIONS_STATUS: "opencode:notifications-status",
    NOTIFICATIONS_SET_PREFERENCES: "opencode:notifications-set-preferences",
  } as const,

  send: {
    OPEN_LINK: "opencode:open-link",
    SHOW_NOTIFICATION: "opencode:show-notification",
    RELAUNCH: "opencode:relaunch",
    LOADING_WINDOW_COMPLETE: "opencode:loading-window-complete",
    PLUGIN_SEND: "opencode:plugin:send",
  } as const,

  push: {
    INIT_STEP: "opencode:init-step",
    STORAGE_MIGRATION_PROGRESS: "opencode:storage-migration-progress",
    MENU_COMMAND: "opencode:menu-command",
    DEEP_LINK: "opencode:deep-link",
    PINCH_ZOOM_ENABLED_CHANGED: "opencode:pinch-zoom-enabled-changed",
    ZOOM_FACTOR_CHANGED: "opencode:zoom-factor-changed",
    PLUGIN_PUSH: "opencode:plugin:push",
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
