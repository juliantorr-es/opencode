import { Button } from "@tribunus/ui/button"
import { useDialog } from "@tribunus/ui/context/dialog"
import type { Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { DialogManageAgents } from "./dialog-manage-agents"

export const SettingsAgents: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()

  const handleManageAgents = () => {
    dialog.show(() => <DialogManageAgents />)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
          <p class="text-14-regular text-text-base">{language.t("settings.agents.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-1">
          <Button variant="primary" size="large" onClick={handleManageAgents}>
            {language.t("dialog.agents.manage")}
          </Button>
        </div>
      </div>
    </div>
  )
}
