/**
 * Public intake lane — anonymous question submission form.
 *
 * Questions are submitted to a hosted queue (stub API in demo mode).
 * The desktop subscribes to the intake queue; an operator approves or
 * ignores submissions. Approved questions get status updates via web polling.
 *
 * Security:
 *  - Public users never reach the desktop directly.
 *  - Intake submissions are queued, never directly executed.
 *  - No backend access is exposed to the public.
 */

import {
  createSignal,
  createMemo,
  type Component,
  type JSX,
} from "solid-js"

/* ── Types ────────────────────────────────────────────────────── */

export interface IntakeQuestion {
  id: string
  question: string
  submittedAt: string
  status: "pending" | "approved" | "ignored"
  note?: string
}

export interface IntakeLaneProps {
  onSubmit: (question: string) => Promise<{ ticketId: string }>
  onPoll: (ticketId: string) => Promise<{
    status: "pending" | "approved" | "ignored"
    note?: string
  } | null>
}

export type SubmitState = "idle" | "submitting" | "submitted" | "error"

/* ── Component ────────────────────────────────────────────────── */

export function PublicIntakeLane(props: IntakeLaneProps): JSX.Element {
  const [question, setQuestion] = createSignal("")
  const [submitState, setSubmitState] = createSignal<SubmitState>("idle")
  const [ticketId, setTicketId] = createSignal<string | null>(null)
  const [errorMsg, setErrorMsg] = createSignal("")
  const [charCount, setCharCount] = createSignal(0)

  const isValid = createMemo(() => {
    const q = question().trim()
    return q.length >= 10 && q.length <= 2000
  })

  const handleInput = (e: Event): void => {
    const target = e.target as HTMLTextAreaElement
    setQuestion(target.value)
    setCharCount(target.value.length)
  }

  const handleSubmit = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!isValid() || submitState() === "submitting") return

    setSubmitState("submitting")
    setErrorMsg("")

    try {
      const result = await props.onSubmit(question().trim())
      setTicketId(result.ticketId)
      setSubmitState("submitted")
    } catch {
      setSubmitState("error")
      setErrorMsg("Failed to submit. Please try again later.")
    }
  }

  const handleReset = (): void => {
    setQuestion("")
    setSubmitState("idle")
    setTicketId(null)
    setCharCount(0)
    setErrorMsg("")
  }

  return (
    <div
      style={{
        background: "var(--c-surface-card)",
        border: "1px solid var(--c-border-light)",
        "border-radius": "var(--radius-lg)",
        padding: "28px",
      }}
    >
      {submitState() === "submitted" && ticketId() ? (
        /* Submitted confirmation */
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            gap: "16px",
            padding: "24px 0",
            "text-align": "center",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              "border-radius": "50%",
              background: "var(--c-success)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "font-size": "24px",
            }}
          >
            ✓
          </div>
          <h3
            style={{
              "font-size": "1.125rem",
              "font-weight": 600,
              color: "var(--c-text)",
              margin: 0,
            }}
          >
            Question Submitted
          </h3>
          <p
            style={{
              "font-size": "0.875rem",
              color: "var(--c-text-muted)",
              margin: 0,
              "max-width": "400px",
              "line-height": "1.5",
            }}
          >
            Your question has been queued for review. A Tribunus operator
            will review and respond. Bookmark your ticket ID to check status.
          </p>
          <div
            style={{
              padding: "8px 16px",
              background: "var(--c-surface-alt)",
              "border-radius": "var(--radius-md)",
              "font-family": "var(--font-mono)",
              "font-size": "0.8125rem",
              color: "var(--c-accent)",
            }}
          >
            {ticketId()}
          </div>
          <button
            type="button"
            onClick={handleReset}
            style={{
              padding: "8px 20px",
              background: "transparent",
              border: "1px solid var(--c-border)",
              color: "var(--c-text)",
              "border-radius": "var(--radius-md)",
              "font-size": "0.8125rem",
              cursor: "pointer",
              transition: "border-color 0.2s",
            }}
            onmouseenter={(e) => {
              ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-primary)"
            }}
            onmouseleave={(e) => {
              ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-border)"
            }}
          >
            Submit Another
          </button>
        </div>
      ) : (
        /* Intake form */
        <form onSubmit={handleSubmit} style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <label
              for="intake-question"
              style={{
                "font-size": "0.875rem",
                "font-weight": 500,
                color: "var(--c-text)",
              }}
            >
              Your Question
            </label>
            <textarea
              id="intake-question"
              value={question()}
              onInput={handleInput}
              placeholder="Ask about Tribunus architecture, missions, or how to contribute…"
              rows={4}
              disabled={submitState() === "submitting"}
              style={{
                width: "100%",
                padding: "12px",
                background: "var(--c-surface)",
                border: "1px solid var(--c-border)",
                "border-radius": "var(--radius-md)",
                color: "var(--c-text)",
                "font-family": "var(--font-sans)",
                "font-size": "0.875rem",
                resize: "vertical",
                "min-height": "100px",
                outline: "none",
                transition: "border-color 0.2s",
              }}
            />
            <div
              style={{
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
              }}
            >
              <span
                style={{
                  "font-size": "0.75rem",
                  color: charCount() > 2000 ? "var(--c-error)" : "var(--c-text-weak)",
                }}
              >
                {charCount()}/2000 characters
              </span>
              {!isValid() && question().trim().length > 0 && (
                <span
                  style={{
                    "font-size": "0.75rem",
                    color: "var(--c-warning)",
                  }}
                >
                  Minimum 10 characters
                </span>
              )}
            </div>
          </div>

          {submitState() === "error" && errorMsg() && (
            <div
              style={{
                padding: "10px 14px",
                background: "var(--c-error)15",
                border: "1px solid var(--c-error)40",
                "border-radius": "var(--radius-md)",
                color: "var(--c-error)",
                "font-size": "0.8125rem",
              }}
            >
              {errorMsg()}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: "12px",
              "align-items": "center",
            }}
          >
            <button
              type="submit"
              disabled={!isValid() || submitState() === "submitting"}
              style={{
                padding: "10px 24px",
                background:
                  !isValid() || submitState() === "submitting"
                    ? "var(--c-border)"
                    : "linear-gradient(135deg, var(--c-primary), var(--c-secondary))",
                color: !isValid() || submitState() === "submitting" ? "var(--c-text-weak)" : "#fff",
                border: "none",
                "border-radius": "var(--radius-md)",
                "font-size": "0.875rem",
                "font-weight": 500,
                cursor: !isValid() || submitState() === "submitting" ? "not-allowed" : "pointer",
                transition: "opacity 0.2s",
              }}
            >
              {submitState() === "submitting" ? "Submitting…" : "Submit Question"}
            </button>
            <span
              style={{
                "font-size": "0.75rem",
                color: "var(--c-text-weak)",
              }}
            >
              No account needed. Questions are queued for operator review.
            </span>
          </div>
        </form>
      )}
    </div>
  )
}
