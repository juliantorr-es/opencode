import * as Sentry from "@sentry/solid"
import { ErrorBoundary, type JSX } from "solid-js"
import { ErrorPage } from "@/pages/error"

interface AppErrorBoundaryProps {
  children: JSX.Element
}

export function AppErrorBoundary(props: AppErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error) => {
        Sentry.captureException(error)
        return <ErrorPage error={error} />
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
