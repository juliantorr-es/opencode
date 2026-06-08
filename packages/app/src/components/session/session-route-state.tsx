import { Button } from "@tribunus/ui/button"
import { Spinner } from "@tribunus/ui/spinner"
import { Show } from "solid-js"
import {
  formatSessionRouteStateLabel,
  type SessionRouteState,
  isHighSignalSessionRouteState,
} from "@/utils/runtime-lifecycle"

export function SessionRouteStatePanel(props: {
  state: SessionRouteState
  onRetry?: () => void
}) {
  return (
    <div class="flex h-full w-full items-center justify-center bg-background-base px-6">
      <div class="w-full max-w-[520px] rounded-2xl border border-border-default bg-background-strong p-5 shadow-[var(--shadow-lg-border-base)]">
        <div class="flex items-start gap-3">
          <div class="mt-0.5">
            <Show
              when={props.state.state === "hydrating"}
              fallback={<div class="size-3 rounded-full bg-icon-warning-base" />}
            >
              <Spinner class="size-4" />
            </Show>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-14-medium text-text-primary">{formatSessionRouteStateLabel(props.state)}</div>
            <div class="mt-1 text-12-regular text-text-tertiary">
              {descriptionForState(props.state)}
            </div>
            <Show when={props.onRetry && isHighSignalSessionRouteState(props.state)}>
              <div class="mt-4">
                <Button variant="secondary" size="small" onClick={props.onRetry}>
                  Retry
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function descriptionForState(state: SessionRouteState) {
  if (state.state === "hydrating") {
    return state.reason ?? "Session is being hydrated from durable state."
  }
  if (state.state === "ready") return "Session data is ready to render."
  if (state.state === "not_yet_readable") return state.reason ?? "Session exists, but the route cannot read it yet."
  if (state.state === "missing") return state.reason ?? "Session does not exist in this project."
  if (state.state === "scope_mismatch") return state.reason ?? "Session belongs to a different scope."
  if (state.state === "backend_unavailable") return state.reason ?? "The backend is unavailable right now."
  return state.reason ?? "Session hydration failed."
}
