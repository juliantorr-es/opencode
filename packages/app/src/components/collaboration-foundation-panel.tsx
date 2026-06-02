import { createSignal, createMemo } from "solid-js"

export interface CollaborationFoundationData {
  coordination: {
    backend: string
    ready: boolean
    pid?: number | null
    url?: string | null
    sha256Verified: boolean
  }
  realtime: {
    taskBoard: boolean
    eventBridge: boolean
    agentHeartbeats: boolean
  }
  scheduling: {
    toolScheduler: boolean
    singleFlight: boolean
    backpressure: boolean
  }
  security: {
    secretStore: boolean
    safeStorageAvailable: boolean
  }
}

export function CollaborationFoundationPanel(props: { data?: CollaborationFoundationData }) {
  const data = () => props.data

  function StatusDot(props: { ready: boolean; label?: string }) {
    return (
      <span class={`inline-block w-2 h-2 rounded-full mr-1.5 ${props.ready ? "bg-green-400" : "bg-yellow-400"}`} title={props.label} />
    )
  }

  const features = createMemo(() => [
    { name: "Live Task Board", ready: data()?.realtime.taskBoard ?? false, description: "Real-time agent status, tool jobs, and lane progress" },
    { name: "Tool Scheduling", ready: data()?.scheduling.toolScheduler ?? false, description: "Resource-class queues prevent machine overload" },
    { name: "Cache Dedup", ready: data()?.scheduling.singleFlight ?? false, description: "Identical expensive tool calls share one result" },
    { name: "Agent Heartbeats", ready: data()?.realtime.agentHeartbeats ?? false, description: "Live agent presence and health monitoring" },
    { name: "Secret Store", ready: data()?.security.secretStore ?? false, description: "OS-encrypted provider/GitHub credentials" },
    { name: "Backpressure", ready: data()?.scheduling.backpressure ?? false, description: "Adaptive throttling under system load" },
  ])

  const comingNext = [
    { name: "LAN/VPN Team Coordinator", description: "Shared coordination across local network" },
    { name: "Senior Sandbox Grants", description: "Role-based approval for high-risk mutations" },
    { name: "Shared Repo Claims", description: "Team-wide file and path ownership" },
    { name: "Peer Identity", description: "Cryptographic agent attribution" },
    { name: "Signed Approvals", description: "Review receipts with cryptographic signatures" },
    { name: "Multi-User Task Board", description: "Shared real-time team dashboard" },
  ]

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 border-b border-surface-border">
        <span class="text-13-regular font-medium">Collaboration Foundation</span>
      </div>

      <div class="flex-1 overflow-auto p-3 space-y-3">
        {/* Coordination status */}
        {data() && (
          <div class="p-2 bg-surface-raised rounded border border-surface-border">
            <div class="text-11-regular text-text-weak">
              Coordination: <span class="text-text font-medium">{data()!.coordination.backend}</span>
            </div>
            <div class="text-11-regular mt-0.5">
              <StatusDot ready={data()!.coordination.ready} />
              {data()!.coordination.ready ? "Valkey active" : "Local mode"}
              {data()!.coordination.url && <span class="text-text-weak ml-1">({data()!.coordination.url})</span>}
            </div>
            {data()!.coordination.sha256Verified && (
              <div class="text-10-regular text-green-400 mt-0.5">SHA256 verified</div>
            )}
          </div>
        )}

        {/* Ready features */}
        <div>
          <span class="text-10-regular text-text-weak uppercase tracking-wider">Ready</span>
          <div class="mt-1 space-y-1">
            {features().filter(f => f.ready).map(f => (
              <div class="flex items-start text-11-regular">
                <StatusDot ready={true} />
                <div>
                  <span class="font-medium">{f.name}</span>
                  <span class="text-text-weak ml-1">{f.description}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* If not ready */}
        {data() && features().filter(f => !f.ready).length > 0 && (
          <div>
            <span class="text-10-regular text-text-weak uppercase tracking-wider">Initializing</span>
            <div class="mt-1 space-y-1">
              {features().filter(f => !f.ready).map(f => (
                <div class="flex items-start text-11-regular">
                  <StatusDot ready={false} />
                  <div>
                    <span class="font-medium">{f.name}</span>
                    <span class="text-text-weak ml-1">{f.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Coming next */}
        <div>
          <span class="text-10-regular text-text-weak uppercase tracking-wider">Coming Next</span>
          <div class="mt-1 space-y-1">
            {comingNext.map(f => (
              <div class="flex items-start text-11-regular text-text-weak">
                <span class="inline-block w-2 h-2 rounded-full mr-1.5 bg-surface-border" />
                <div>
                  <span class="font-medium">{f.name}</span>
                  <span class="ml-1">{f.description}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Platform */}
        <div class="text-10-regular text-text-weak border-t border-surface-border pt-2">
          <span class="uppercase tracking-wider">Platform</span>
          <div class="mt-0.5">
            macOS (Apple Silicon + Intel) — fully supported<br/>
            Linux / Windows — planned; LocalFabric fallback available
          </div>
        </div>
      </div>
    </div>
  )
}
