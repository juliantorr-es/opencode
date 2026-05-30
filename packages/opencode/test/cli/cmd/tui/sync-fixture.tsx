/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { createEventSource, createFetch, type FetchHandler, directory } from "../../../fixture/tui-sdk"

function ArgsProvider(props: { children: any }) { return props.children }
const createExit = (fn: () => Promise<void>) => ({ exit: fn })
function ExitProvider(props: { children: any; exit: { exit: () => Promise<void> } }) { return props.children }
function KVProvider(props: { children: any }) { return props.children }
function useKV() { return { get: <T,>(k: string, fb?: T) => fb, set(_k: string, _v: unknown) {}, ready: true } }
function ProjectProvider(props: { children: any }) { return props.children }
function useProject() { return { workspace: { set(_name: string) {} } } }
function SDKProvider(props: { children: any; url: string; directory: string; fetch: any; events: { subscribe: (h: any) => Promise<() => void> } }) { return props.children }
function SyncProvider(props: { children: any }) { return props.children }
function useSync() { return { status: "complete" as const, data: { vcs: { branch: "main" as string | undefined } }, session: { refresh: async () => {}, sync: async (_id: string) => {} } } }
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = { kv: ReturnType<typeof useKV>; project: ReturnType<typeof useProject>; sync: ReturnType<typeof useSync> }

export async function mount(override?: FetchHandler) {
  const calls = createFetch(override)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSync() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider exit={createExit(async () => {})}>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
            <ProjectProvider>
              <SyncProvider>
                <Probe />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, kv, project, sync, session: calls.session }
}
