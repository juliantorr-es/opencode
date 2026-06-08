import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Splash } from "@tribunus/ui/logo"
import { Button } from "@tribunus/ui/button"
import { DropdownMenu } from "@tribunus/ui/dropdown-menu"
import { IconButton } from "@tribunus/ui/icon-button"
import { Tooltip } from "@tribunus/ui/tooltip"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
} from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { base64Encode } from "@tribunus/core/util/encode"
import { getFilename } from "@tribunus/core/util/path"
import { useParams } from "@solidjs/router"
import { useLayout, type LocalProject } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useProjectActivation } from "@/context/project-activation"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { LocalWorkspace, SortableWorkspace, WorkspaceDragOverlay, type WorkspaceSidebarContext } from "./sidebar-workspace"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  placeholder?: string
  disabled?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element
export interface SidebarPanelProps {
  project: Accessor<LocalProject | undefined>
  mobile?: boolean
  merged?: boolean
  // Closure dependencies from Layout
  panel: Accessor<number>
  sidebarHovering: Accessor<boolean>
  setStore: (path: string, ...args: unknown[]) => void
  store: { activeWorkspace: string | undefined; gettingStartedDismissed: boolean }
  workspaceIds: (project: LocalProject | undefined) => string[]
  sortNow: () => number
  navigateWithSidebarReset: (href: string) => void
  renameProject: (project: LocalProject, next: string) => Promise<void>
  closeProject: (directory: string) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  showEditProjectDialog: (project: LocalProject) => void
  chooseProject: () => Promise<void>
  connectProvider: () => void
  openSettings: () => void
  handleWorkspaceDragStart: (event: unknown) => void
  handleWorkspaceDragEnd: () => void
  handleWorkspaceDragOver: (event: DragEvent) => void
  createWorkspace: (project: LocalProject) => Promise<void>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  sidebarProject: Accessor<LocalProject | undefined>
  workspaceSidebarCtx: WorkspaceSidebarContext
  InlineEditor: InlineEditorComponent
}

export const SidebarPanel = (panelProps: SidebarPanelProps) => {
  const layout = useLayout()
  const params = useParams<{ dir?: string }>()
  const notification = useNotification()
  const language = useLanguage()
  const providers = useProviders()
  const serverSync = useServerSync()
  const activation = useProjectActivation()

  const project = panelProps.project
  const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
  const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
  const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
  const projectName = createMemo(() => {
    const item = project()
    if (!item) return ""
    return item.name || getFilename(item.worktree)
  })
  const projectId = createMemo(() => project()?.id ?? "")
  const worktree = createMemo(() => project()?.worktree ?? "")
  const slug = createMemo(() => {
    const dir = worktree()
    if (!dir) return ""
    return base64Encode(dir)
  })
  const workspaces = createMemo(() => {
    const item = project()
    if (!item) return [] as string[]
    return panelProps.workspaceIds(item)
  })
  const unseenCount = createMemo(() =>
    workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const clearNotifications = () =>
    workspaces()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
  const workspacesEnabled = createMemo(() => {
    const item = project()
    if (!item) return false
    if (item.vcs !== "git") return false
    return layout.sidebar.workspaces(item.worktree)()
  })
  const canToggle = createMemo(() => {
    const item = project()
    if (!item) return false
    return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
  })
  const homedir = createMemo(() => serverSync.data.path.home)

  return (
    <div
      classList={{
        "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
        "border border-b-0 border-border-weak-base": !merged(),
        "border-l border-t border-border-weaker-base": merged(),
        "bg-background-base": merged() || hover(),
        "bg-background-stronger": !merged() && !hover(),
        "flex-1 min-w-0": panelProps.mobile,
        "max-w-full overflow-hidden": panelProps.mobile,
      }}
      style={{
        width: panelProps.mobile ? undefined : `${panelProps.panel()}px`,
      }}
    >
      <Show
        when={project()}
        fallback={
          <>
            <Show when={activation.state().name === "provider_setup_required"}>
              <Dialog open={true}>
                <Dialog.Content>
                  <Dialog.Title>Provider setup required</Dialog.Title>
                  <Dialog.Description>
                    This project is open, but no model provider is configured.
                    Configure a model provider before starting a session.
                  </Dialog.Description>
                  <div class="flex gap-2 mt-4">
                    <Button onClick={panelProps.openSettings}>Open Settings</Button>
                    <Button variant={"outline" as any} onClick={() => activation.send({ type: "RETRY" })}>Retry</Button>
                  </div>
                </Dialog.Content>
              </Dialog>
            </Show>
            <Show when={activation.state().name === "failed"}>
              <Dialog open={true}>
                <Dialog.Content>
                  <Dialog.Title>Project failed to load</Dialog.Title>
                  <Dialog.Description>
                    {activation.diagnostics().error ?? "Unknown error"}
                  </Dialog.Description>
                  <div class="flex gap-2 mt-4">
                    <Button onClick={() => activation.send({ type: "RETRY" })}>Retry</Button>
                    <Button variant={"outline" as any} onClick={() => {
                      void navigator.clipboard.writeText(JSON.stringify(activation.diagnostics(), null, 2))
                    }}>Copy Diagnostics</Button>
                  </div>
                </Dialog.Content>
              </Dialog>
            </Show>
            <Show when={empty()}>
              <div class="flex flex-col items-center justify-center h-full gap-4 p-6">
                <Splash class="w-12 h-15" />
                <p class="text-14-regular text-text-base text-center">
                  No project loaded. The local sidecar is running,{"\n"}
                  but this desktop app has no active project yet.
                </p>
                <p class="text-12-regular text-text-weak">
                  Sidecar: ready · Database: fresh · Instances: 0
                </p>
                <Button size="large" icon="folder-add-left" onClick={panelProps.chooseProject}>
                  Open a repository to start
                </Button>
              </div>
            </Show>
            <Show when={!empty() && activation.state().name !== "provider_setup_required" && activation.state().name !== "failed" && activation.state().name !== "project_ready" && activation.state().name !== "uninitialized" && activation.state().name !== "empty"}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">Opening project\u2026</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button
                    size="large"
                    icon="folder-add-left"
                    disabled={!activation.canOpenProject()}
                    onClick={panelProps.chooseProject}
                  >
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          </>
        }
        keyed
      >
        {(project) => (
          <>
            <div class="shrink-0 pl-1 py-1">
              <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                <div class="flex flex-col min-w-0">
                  <panelProps.InlineEditor
                    id={`project:${projectId()}`}
                    value={projectName}
                    onSave={(next: string) => {
                      void panelProps.renameProject(project, next)
                    }}
                    class="text-14-medium text-text-strong truncate"
                    displayClass="text-14-medium text-text-strong truncate"
                    stopPropagation
                  />

                  <Tooltip
                    placement="bottom"
                    gutter={2}
                    value={worktree()}
                    class="shrink-0"
                    contentStyle={{
                      "max-width": "640px",
                      transform: "translate3d(52px, 0, 0)",
                    }}
                  >
                    <span class="text-12-regular text-text-base truncate select-text">
                      {worktree().replace(homedir(), "~")}
                    </span>
                  </Tooltip>
                </div>

                <DropdownMenu modal={!panelProps.sidebarHovering()}>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="dot-grid"
                    variant="ghost"
                    data-action="project-menu"
                    data-project={slug()}
                    class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                    classList={{
                      "opacity-100": panelProps.mobile || merged(),
                      "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                        !panelProps.mobile && !merged(),
                    }}
                    aria-label={language.t("common.moreOptions")}
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="mt-1">
                      <DropdownMenu.Item
                        onSelect={() => {
                          panelProps.showEditProjectDialog(project)
                        }}
                      >
                        <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        data-action="project-workspaces-toggle"
                        data-project={slug()}
                        disabled={!canToggle()}
                        onSelect={() => {
                          panelProps.toggleProjectWorkspaces(project)
                        }}
                      >
                        <DropdownMenu.ItemLabel>
                          {workspacesEnabled()
                            ? language.t("sidebar.workspaces.disable")
                            : language.t("sidebar.workspaces.enable")}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        data-action="project-clear-notifications"
                        data-project={slug()}
                        disabled={unseenCount() === 0}
                        onSelect={clearNotifications}
                      >
                        <DropdownMenu.ItemLabel>
                          {language.t("sidebar.project.clearNotifications")}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        data-action="project-close-menu"
                        data-project={slug()}
                        onSelect={() => {
                          const dir = worktree()
                          if (!dir) return
                          panelProps.closeProject(dir)
                        }}
                      >
                        <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            </div>

            <div class="flex-1 min-h-0 flex flex-col">
              <Show
                when={workspacesEnabled()}
                fallback={
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="new-session"
                        class="w-full"
                        onClick={() => {
                          const dir = worktree()
                          if (!dir) return
                          panelProps.navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                        }}
                      >
                        {language.t("command.session.new")}
                      </Button>
                    </div>
                    <div class="flex-1 min-h-0">
                      <LocalWorkspace
                        ctx={panelProps.workspaceSidebarCtx}
                        project={project}
                        sortNow={panelProps.sortNow}
                        mobile={panelProps.mobile}
                      />
                    </div>
                  </>
                }
              >
                <>
                  <div class="shrink-0 py-4">
                    <Button
                      size="large"
                      icon="plus-small"
                      class="w-full"
                      onClick={() => {
                        void panelProps.createWorkspace(project)
                      }}
                    >
                      {language.t("workspace.new")}
                    </Button>
                  </div>
                  <div class="relative flex-1 min-h-0">
                    <DragDropProvider
                      onDragStart={panelProps.handleWorkspaceDragStart}
                      onDragEnd={panelProps.handleWorkspaceDragEnd}
                      onDragOver={panelProps.handleWorkspaceDragOver}
                      collisionDetector={closestCenter}
                    >
                      <DragDropSensors />
                      <ConstrainDragXAxis />
                      <div class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]">
                        <SortableProvider ids={workspaces()}>
                          <For each={workspaces()}>
                            {(directory) => (
                              <SortableWorkspace
                                ctx={panelProps.workspaceSidebarCtx}
                                directory={directory}
                                project={project}
                                sortNow={panelProps.sortNow}
                                mobile={panelProps.mobile}
                              />
                            )}
                          </For>
                        </SortableProvider>
                      </div>
                      <DragOverlay>
                        <WorkspaceDragOverlay
                          sidebarProject={panelProps.sidebarProject}
                          activeWorkspace={() => panelProps.store.activeWorkspace}
                          workspaceLabel={panelProps.workspaceLabel}
                        />
                      </DragOverlay>
                    </DragDropProvider>
                  </div>
                </>
              </Show>
            </div>
          </>
        )}
      </Show>

      <div
        class="shrink-0 px-3 py-3"
        classList={{
          hidden: panelProps.store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
        }}
      >
        <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
          <div class="p-3 flex flex-col gap-6">
            <div class="flex flex-col gap-2">
              <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
              <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                {language.t("sidebar.gettingStarted.line1")}
              </div>
              <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                {language.t("sidebar.gettingStarted.line2")}
              </div>
            </div>
            <div data-component="getting-started-actions">
              <Button size="large" icon="plus-small" onClick={panelProps.connectProvider}>
                {language.t("command.provider.connect")}
              </Button>
              <Button size="large" variant="ghost" onClick={() => panelProps.setStore("gettingStartedDismissed", true)}>
                {language.t("toast.update.action.notYet")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
