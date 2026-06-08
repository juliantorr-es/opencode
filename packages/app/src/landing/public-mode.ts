/**
 * Public-mode landing page entry — renders demo data through Solid components.
 *
 * This module is the main entry for the stand-alone landing page.
 * It mounts a lightweight Solid.js app that displays demo missions,
 * architecture cards, a codex browser, and the public intake form.
 *
 * Security: public users never reach the desktop, filesystem, Valkey,
 * PGlite, or local network. All data is read-only demo data.
 */

import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js"
import { render } from "solid-js/web"
import {
  PublicIntakeLane,
  type IntakeQuestion,
} from "./intake-lane"
import { CodexBrowser, type CodexPage } from "./codex-browser"

/* ── Demo Data ──────────────────────────────────────────────── */

interface DemoMission {
  id: string
  title: string
  description: string
  status: "completed" | "in_progress" | "planned"
  progress: number
  agents: number
  tasks: number
  completedTasks: number
  tags: string[]
}

interface ArchitectureCard {
  title: string
  description: string
  icon: string
  tags: string[]
}

const DEMO_MISSIONS: DemoMission[] = [
  {
    id: "m1",
    title: "Authority Binding & Kernel Completion",
    description:
      "Bind the authority validation kernel and complete the crash-recovery protocol for multi-agent coordination.",
    status: "completed",
    progress: 100,
    agents: 4,
    tasks: 28,
    completedTasks: 28,
    tags: ["kernel", "authority", "recovery"],
  },
  {
    id: "m2",
    title: "Valkey Stream-Backed Coordination",
    description:
      "Implement stream-backed coordination kernel with consumer groups, pending-entry lists, and auto-claim recovery.",
    status: "completed",
    progress: 100,
    agents: 3,
    tasks: 18,
    completedTasks: 18,
    tags: ["valkey", "streams", "coordination"],
  },
  {
    id: "m3",
    title: "Public Intake & GitHub Pages",
    description:
      "Build the public-facing landing page, codex browser, and intake lane for external question submission.",
    status: "in_progress",
    progress: 72,
    agents: 2,
    tasks: 14,
    completedTasks: 10,
    tags: ["landing", "intake", "pwa"],
  },
  {
    id: "m4",
    title: "P2P Agent Synchronization",
    description:
      "Design gossip-based agent state sync protocol for decentralized mission execution without a central coordinator.",
    status: "planned",
    progress: 0,
    agents: 5,
    tasks: 34,
    completedTasks: 0,
    tags: ["p2p", "sync", "gossip"],
  },
  {
    id: "m5",
    title: "Codex Knowledge Compilation",
    description:
      "Build the compiled-knowledge pipeline that ingests architecture decisions and produces source-backed memory artifacts.",
    status: "planned",
    progress: 0,
    agents: 2,
    tasks: 12,
    completedTasks: 0,
    tags: ["codex", "knowledge", "compilation"],
  },
]

const ARCHITECTURE_CARDS: ArchitectureCard[] = [
  {
    title: "Agent Kernel",
    description:
      "Minimal, single-purpose agent process with stream-based IPC. Each agent owns a private scope and communicates via bounded channels.",
    icon: "\u2699",
    tags: ["Rust", "tokio", "IPC"],
  },
  {
    title: "Coordination Layer",
    description:
      "Valkey streams provide durable, ordered work queues. Consumer groups distribute load; pending-entry lists track in-flight work.",
    icon: "\u2194",
    tags: ["Valkey", "streams", "queues"],
  },
  {
    title: "Public Intake",
    description:
      "Anonymous question intake via queued submissions. Desktop subscribes to the intake queue; operator approves or ignores from a controlled UI.",
    icon: "\u2197",
    tags: ["queue", "moderation", "PWA"],
  },
  {
    title: "Codex",
    description:
      "Read-only knowledge browser compiling architecture decisions, research packets, and implementation specs into a searchable artifact.",
    icon: "\u2606",
    tags: ["search", "read-only", "docs"],
  },
]

const DEMO_CODEX_PAGES: CodexPage[] = [
  {
    id: "adr-001",
    title: "Use Valkey Streams for Coordination Kernel",
    excerpt:
      "Adopt Valkey streams over Redis pub/sub for durable, replayable work queues with consumer groups and auto-claim recovery.",
    tags: ["ADR", "valkey", "coordination"],
    updated: "2026-05-28",
  },
  {
    id: "adr-002",
    title: "Multi-Agent Authority Model",
    excerpt:
      "Each agent operates under a bounded authority scope enforced by a kernel-managed validation layer. No agent may escalate privileges.",
    tags: ["ADR", "authority", "security"],
    updated: "2026-05-30",
  },
  {
    id: "adr-003",
    title: "Public Intake Queue via Valkey Streams",
    excerpt:
      "Anonymous submissions are written to a dedicated intake stream. Desktop consumers process the stream; approved questions generate status updates.",
    tags: ["ADR", "intake", "queue"],
    updated: "2026-06-02",
  },
  {
    id: "research-001",
    title: "Valkey Stream Consumer Group Patterns",
    excerpt:
      "Survey of consumer group semantics, pending entry lists, and auto-claim for building reliable work distribution.",
    tags: ["research", "valkey", "streams"],
    updated: "2026-05-25",
  },
  {
    id: "spec-001",
    title: "Public Landing & Intake Specification",
    excerpt:
      "Implementation specification covering the GitHub Pages shell, PWA manifest, service worker, and public intake lane.",
    tags: ["spec", "landing", "intake"],
    updated: "2026-06-05",
  },
]

/* ── Stub API ─────────────────────────────────────────────────── */

/**
 * Submit a question to the public intake queue.
 * In production this POSTs to a hosted queue endpoint; in demo mode
 * it simulates a submission and returns a fake ticket ID.
 */
export async function submitIntakeQuestion(question: string): Promise<{ ticketId: string }> {
  // Stub — in production, POST to the hosted intake API
  const ticketId = `ticket-${crypto.randomUUID().slice(0, 8)}`
  // Simulate network latency
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 600)
  await promise
  return { ticketId }
}

/**
 * Poll for status updates on a submitted ticket.
 * Returns null while pending; returns an update once processed.
 */
export async function pollTicketStatus(
  _ticketId: string,
): Promise<{ status: "pending" | "approved" | "ignored"; note?: string } | null> {
  // Stub — always returns pending for demo
  return null
}

/* ── Sub-components ──────────────────────────────────────────── */

function StatusBadge(props: { status: DemoMission["status"] }): JSX.Element {
  const colors: Record<DemoMission["status"], string> = {
    completed: "var(--c-success)",
    in_progress: "var(--c-accent)",
    planned: "var(--c-text-weak)",
  }
  const labels: Record<DemoMission["status"], string> = {
    completed: "Completed",
    in_progress: "In Progress",
    planned: "Planned",
  }
  return (
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "4px",
        padding: "2px 8px",
        "border-radius": "var(--radius-full, 9999px)",
        "font-size": "0.75rem",
        "font-weight": 500,
        background: `${colors[props.status]}1a`,
        color: colors[props.status],
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          "border-radius": "50%",
          background: colors[props.status],
        }}
      />
      {labels[props.status]}
    </span>
  )
}

function ProgressBar(props: { value: number }): JSX.Element {
  return (
    <div
      style={{
        width: "100%",
        height: "4px",
        background: "var(--c-border)",
        "border-radius": "9999px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${props.value}%`,
          height: "100%",
          "border-radius": "9999px",
          background: "linear-gradient(90deg, var(--c-primary), var(--c-secondary))",
          transition: "width 0.5s ease",
        }}
      />
    </div>
  )
}

function MissionCard(props: { mission: DemoMission }): JSX.Element {
  return (
    <div
      style={{
        background: "var(--c-surface-card)",
        border: "1px solid var(--c-border-light)",
        "border-radius": "var(--radius-lg)",
        padding: "20px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        transition: "border-color 0.2s, box-shadow 0.2s",
        cursor: "default",
      }}
      onmouseenter={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-primary)"
        ;(e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-card)"
      }}
      onmouseleave={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-border-light)"
        ;(e.currentTarget as HTMLElement).style.boxShadow = "none"
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "flex-start" }}>
        <div>
          <h3
            style={{
              "font-size": "1rem",
              "font-weight": 600,
              color: "var(--c-text)",
              margin: 0,
            }}
          >
            {props.mission.title}
          </h3>
          <p
            style={{
              "font-size": "0.8125rem",
              color: "var(--c-text-muted)",
              margin: "4px 0 0",
              "line-height": "1.5",
            }}
          >
            {props.mission.description}
          </p>
        </div>
        <StatusBadge status={props.mission.status} />
      </div>
      <div style={{ display: "flex", gap: "16px", "font-size": "0.8125rem", color: "var(--c-text-weak)" }}>
        <span>
          <strong style={{ color: "var(--c-text)" }}>{props.mission.agents}</strong> agents
        </span>
        <span>
          <strong style={{ color: "var(--c-text)" }}>{props.mission.completedTasks}/{props.mission.tasks}</strong> tasks
        </span>
      </div>
      <ProgressBar value={props.mission.progress} />
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        {props.mission.tags.map((tag) => (
          <span
            style={{
              padding: "2px 8px",
              "border-radius": "var(--radius-sm)",
              background: "var(--c-surface-alt)",
              color: "var(--c-text-weak)",
              "font-size": "0.6875rem",
              "font-family": "var(--font-mono)",
            }}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}

function ArchitectureCardComponent(props: { card: ArchitectureCard }): JSX.Element {
  return (
    <div
      style={{
        background: "var(--c-surface-card)",
        border: "1px solid var(--c-border-light)",
        "border-radius": "var(--radius-lg)",
        padding: "24px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        transition: "border-color 0.2s",
      }}
      onmouseenter={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-secondary)"
      }}
      onmouseleave={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = "var(--c-border-light)"
      }}
    >
      <div
        style={{
          width: "40px",
          height: "40px",
          "border-radius": "var(--radius-md)",
          background: "linear-gradient(135deg, var(--c-primary), var(--c-secondary))",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "font-size": "1.25rem",
        }}
      >
        {props.card.icon}
      </div>
      <h3 style={{ "font-size": "1rem", "font-weight": 600, color: "var(--c-text)", margin: 0 }}>
        {props.card.title}
      </h3>
      <p style={{ "font-size": "0.8125rem", color: "var(--c-text-muted)", margin: 0, "line-height": "1.5" }}>
        {props.card.description}
      </p>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        {props.card.tags.map((tag) => (
          <span
            style={{
              padding: "2px 8px",
              "border-radius": "var(--radius-sm)",
              background: "var(--c-surface-alt)",
              color: "var(--c-accent)",
              "font-size": "0.6875rem",
              "font-family": "var(--font-mono)",
            }}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── Hero ─────────────────────────────────────────────────────── */

function Hero(): JSX.Element {
  return (
    <section
      style={{
        "text-align": "center",
        padding: "80px 24px 48px",
        "max-width": "720px",
        margin: "0 auto",
      }}
    >
      <div
        style={{
          width: "64px",
          height: "64px",
          "border-radius": "var(--radius-xl)",
          background: "linear-gradient(135deg, var(--c-primary), var(--c-secondary))",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          margin: "0 auto 24px",
          "font-size": "32px",
          "font-weight": 700,
          color: "#fff",
        }}
      >
        T
      </div>
      <h1
        style={{
          "font-size": "2.5rem",
          "font-weight": 700,
          color: "var(--c-text)",
          margin: "0 0 12px",
          "letter-spacing": "-0.02em",
        }}
      >
        Tribunus
      </h1>
      <p
        style={{
          "font-size": "1.125rem",
          color: "var(--c-text-muted)",
          "line-height": "1.6",
          margin: "0 0 32px",
        }}
      >
        Open-source multi-agent orchestration framework.
        <br />
        Plan missions, coordinate agents, and compile knowledge — all governed by bounded authority.
      </p>
      <div style={{ display: "flex", gap: "12px", "justify-content": "center" }}>
        <a
          href="#intake"
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "8px",
            padding: "10px 24px",
            background: "linear-gradient(135deg, var(--c-primary), var(--c-secondary))",
            color: "#fff",
            "border-radius": "var(--radius-md)",
            "font-size": "0.875rem",
            "font-weight": 500,
            transition: "opacity 0.2s",
          }}
          onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.9" }}
          onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1" }}
        >
          Ask a Question
        </a>
        <a
          href="#missions"
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "8px",
            padding: "10px 24px",
            border: "1px solid var(--c-border)",
            color: "var(--c-text)",
            "border-radius": "var(--radius-md)",
            "font-size": "0.875rem",
            "font-weight": 500,
            transition: "border-color 0.2s",
          }}
          onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--c-primary)" }}
          onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--c-border)" }}
        >
          View Missions
        </a>
      </div>
    </section>
  )
}

/* ── Section Wrapper ─────────────────────────────────────────── */

function Section(props: {
  id?: string
  title: string
  subtitle?: string
  children: JSX.Element
  wide?: boolean
}): JSX.Element {
  return (
    <section
      id={props.id}
      style={{
        padding: "48px 24px",
        "max-width": props.wide ? "1080px" : "920px",
        margin: "0 auto",
      }}
    >
      <div style={{ "margin-bottom": "28px" }}>
        <h2
          style={{
            "font-size": "1.5rem",
            "font-weight": 600,
            color: "var(--c-text)",
            margin: 0,
          }}
        >
          {props.title}
        </h2>
        {props.subtitle && (
          <p
            style={{
              "font-size": "0.875rem",
              color: "var(--c-text-muted)",
              margin: "6px 0 0",
            }}
          >
            {props.subtitle}
          </p>
        )}
      </div>
      {props.children}
    </section>
  )
}

/* ── Footer ───────────────────────────────────────────────────── */

function Footer(): JSX.Element {
  return (
    <footer
      style={{
        "text-align": "center",
        padding: "32px 24px",
        "border-top": "1px solid var(--c-border-light)",
        "font-size": "0.8125rem",
        color: "var(--c-text-weak)",
      }}
    >
      <p style={{ margin: 0 }}>
        Tribunus — AGPL-3.0 licensed &middot;{" "}
        <a
          href="https://github.com/tribunus-ai/Tribunus"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
      </p>
    </footer>
  )
}

/* ── Root App ─────────────────────────────────────────────────── */

function App(): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "min-height": "100dvh",
      }}
    >
      <Hero />
      <Section
        id="missions"
        title="Mission Timeline"
        subtitle="Active and planned missions in the Tribunus roadmap"
      >
        <div
          style={{
            display: "grid",
            "grid-template-columns": "repeat(auto-fill, minmax(340px, 1fr))",
            gap: "16px",
          }}
        >
          {DEMO_MISSIONS.map((mission) => (
            <MissionCard mission={mission} />
          ))}
        </div>
      </Section>
      <Section
        title="Architecture"
        subtitle="Core architectural components"
      >
        <div
          style={{
            display: "grid",
            "grid-template-columns": "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {ARCHITECTURE_CARDS.map((card) => (
            <ArchitectureCardComponent card={card} />
          ))}
        </div>
      </Section>
      <Section
        id="codex"
        title="Codex Browser"
        subtitle="Read-only knowledge browser — architecture decisions, research, and specs"
        wide
      >
        <CodexBrowser pages={DEMO_CODEX_PAGES} />
      </Section>
      <Section
        id="intake"
        title="Ask a Question"
        subtitle="Submit a question or idea. A Tribunus operator will review and respond."
      >
        <PublicIntakeLane onSubmit={submitIntakeQuestion} onPoll={pollTicketStatus} />
      </Section>
      <Footer />
    </div>
  )
}

/* ── Mount ────────────────────────────────────────────────────── */

const root = document.getElementById("root")
if (root) {
  render(() => <App />, root)
}
