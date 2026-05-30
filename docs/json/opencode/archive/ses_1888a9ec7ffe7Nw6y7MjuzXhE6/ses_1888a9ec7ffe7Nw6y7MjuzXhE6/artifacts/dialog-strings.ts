/**
 * Structured dialog strings for native Electron dialogs.
 *
 * These are English-only for now. Cross-package i18n bridge (sharing app locale
 * files with the desktop main process) is deferred to a future lane.
 *
 * Dialog keys are also present in packages/app/src/i18n/en.ts for reference.
 */
export const DIALOG_STRINGS = {
  recovery: {
    relaunch: "Relaunch",
    exportLogs: "Export Logs",
    keepWaiting: "Keep Waiting",
    quit: "Quit",
    failedToLoad: "OpenCode failed to load",
    terminated: "OpenCode window terminated unexpectedly",
    notResponding: "OpenCode is not responding",
    notRespondingDetail: "You can relaunch the app, open the logs, or keep waiting.",
  },
} as const

export type DialogStrings = typeof DIALOG_STRINGS
