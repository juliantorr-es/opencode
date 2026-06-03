import { type Accessor, createMemo } from "solid-js"

interface LoadingResource {
  name: string
  loading: boolean
}

export function MainWindowBootFallback(props: { resources: LoadingResource[] }) {
  const pending = createMemo(() => props.resources.filter((r) => r.loading).map((r) => r.name))

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        height: "100vh",
        width: "100vw",
        background: "#0d0d0d",
        color: "#888888",
        "font-family": "system-ui, -apple-system, sans-serif",
        "font-size": "14px",
      }}
    >
      <div style={{ "font-size": "18px", "font-weight": 600, "margin-bottom": "16px", color: "#eeeeee" }}>
        Starting Tribunus Desktop
      </div>
      <div style={{ opacity: 0.7 }}>
        {pending().length > 0
          ? `Waiting for: ${pending().join(", ")}`
          : "Initializing..."}
      </div>
      <div style={{ "margin-top": "32px", opacity: 0.3 }}>
        <div
          style={{
            width: "24px",
            height: "24px",
            border: "2px solid #444444",
            "border-top-color": "#6366f1",
            "border-radius": "50%",
            animation: "tribunus-spin 0.8s linear infinite",
          }}
        />
      </div>
      <style>
        {`@keyframes tribunus-spin { to { transform: rotate(360deg); } }`}
      </style>
    </div>
  )
}
