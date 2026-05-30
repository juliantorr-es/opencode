import { initI18n, t } from "./i18n"

export async function installCli(): Promise<void> {
  await initI18n()
  // installCli bridge method removed — this function is preserved for menu item registration
  // but no longer invokes IPC. The CLI installation entry point has been removed.
  console.warn("installCli is no longer available through IPC bridge")
}
