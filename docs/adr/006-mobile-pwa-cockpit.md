# ADR 006: Mobile PWA as Remote Cockpit

## Status
Accepted — June 2026

## Context

Tribunus is a native macOS desktop application. It spawns child processes (Valkey), owns the filesystem, runs agent orchestration, and hosts the coordination kernel. These capabilities are outside the browser sandbox — a PWA cannot replace the native app.

However, a mobile PWA can serve as a remote cockpit: observing the desktop's state, sending operator intents, and receiving push notifications when the user is away from their machine.

## Decision

### Architecture

```
Phone (PWA)                              Desktop (Tribunus)
┌─────────────────┐    ┌──────────┐    ┌──────────────────────────┐
│ Service Worker  │◄───│  Relay   │◄───│ Valkey pub/sub            │
│ Cockpit UI      │◄───│  (auth,  │◄───│ Local API server          │
│ Session control │───►│  routing,│───►│ Agent orchestration       │
│ Codex browser   │◄───│  push)   │◄───│ PGlite (durable truth)    │
│ Dharma dashboard│    └──────────┘    │ File system, terminals,   │
│ Approve/reject  │                    │ LLM calls, test runners   │
└─────────────────┘                    └──────────────────────────┘
```

**Desktop does not expose itself to the internet.** The desktop establishes an outbound authenticated connection to a relay. The phone connects to the same relay. The relay handles auth, presence, message routing, push fanout, and durable notification envelopes. The desktop remains the execution authority.

### Three-Layer Model

**Projection Stream** — Cursored, append-only state deltas from desktop to phone.
- Session status, active agents, gate requests, queue state, dharma stats, codex updates, diagnostics, receipts, failures
- Delivered via WebSocket while the PWA is open
- Chunked or cursored to handle backpressure (WebSocket API does not support native backpressure)
- Phone caches last-known projections locally (convenience, not truth)

**Command Gateway** — Capability-scoped intents from phone to desktop.
- Approve gate, pause agent, resume session, cancel run, request diagnostic packet, mark help request handled
- NOT raw shell access, NOT filesystem access, NOT agent process access
- Every command carries: auth token, idempotency key, replay protection, capability scope
- Desktop validates, executes, and emits an accepted/rejected receipt
- Phone command is an "external operator action" — not a trusted local click

**Notification Gateway** — Event-triggered alerts.
- "Gate waiting," "agent failed," "diagnostic confirmed," "new match found," "desktop disconnected"
- Push is an alert channel, NOT a realtime control channel
- Push says "something changed, open/resync" — the phone fetches fresh projections on open
- iOS requires Home Screen installation for Web Push (iOS 16.4+, Push API + Notifications API + Service Worker)
- All PWA communication requires HTTPS (Service Worker secure context requirement)

### Pairing Flow

1. User enables "Mobile Cockpit" in desktop app
2. Desktop generates a QR code containing: pairing URL + short-lived one-time challenge
3. User scans QR with phone → opens the PWA
4. Phone completes device claim, receives a scoped capability token
5. Phone registers for push notifications
6. Phone begins receiving projection deltas

### Authority Rules

- **PGlite/desktop projection remains authoritative.** The phone never owns truth.
- **Valkey remains local coordination.** The relay is transport, not truth.
- **The PWA cache is convenience, not truth.** On reconnect, the phone discards stale projections and resyncs from cursor 0.
- **Command intents are auditable.** Every accepted/rejected command produces a receipt in PGlite.
- **If the desktop is offline**, the phone shows cached last-known projections and queued notification history. It cannot control live agents until the desktop reconnects.

## Consequences

### Positive
- **Zero new native apps.** One PWA serves iOS and Android. No App Store, no Play Store, no review process.
- **Desktop stays powerful.** Native filesystem access, child processes, shell execution, raw TCP — all stay on the desktop where they belong.
- **Security model is clean.** The phone is a capability-scoped observer and intent-sender. It cannot execute arbitrary commands or access the filesystem.
- **Push is real.** Web Push works on iOS 16.4+ for Home Screen-installed PWAs.

### Negative
- **Relay infrastructure needed.** The desktop and phone must rendezvous through a relay. This is new infrastructure (though lightweight — essentially an auth proxy + WebSocket fanout + push delivery).
- **No offline agent control.** The phone cannot spawn or control agents when the desktop is offline. This is architecturally correct, but users may expect independent mobile operation.
- **WebSocket backpressure.** Large projection bursts must be chunked. The WebSocket API does not support native flow control.
- **iOS push requires Home Screen install.** Users must add the PWA to their Home Screen before push notifications behave like native app notifications.


## UI Architecture

### Strategy: Touch Shell + Headless Domain Components

The mobile PWA does not adopt any single UI framework as its design system. Instead, it separates concerns:

- **Lit** (Web Components) is the durable component substrate. All Tribunus domain components — AgentCard, GateRequest, ProjectionLog, DharmaPanel, QueueItem, ReceiptViewer, SessionStrip — are Lit elements.
- **Ionic** is used selectively for mobile-native touch primitives where the browser is annoying: sheet modals, toasts, bottom tabs, pull-to-refresh, gesture handling, and platform-safe navigation stacks. Ionic does not own the architecture; it supplies the touch shell.
- **CSS Container Queries** adapt layouts across form factors without framework-specific responsive logic. Phone gets a mobile cockpit layout (bottom tabs, stacked views, large approve/deny touch targets). iPad gets a multi-pane dashboard layout (persistent agent rail, live projection log, gate queue). Desktop browser gets denser panels from the same components.
- **The projection stream is the binding layer.** All components bind to projection deltas from the desktop, not to UI framework state. The command gateway sends operator intents, not UI framework events. The UI is a rendered view of the projection model, not a stateful app.

### Form-Factor Adaptation

| Form Factor | Layout | Shell |
|-------------|--------|-------|
| Phone (portrait) | Single-column, bottom tabs, stacked views, large touch targets | Ionic tabs + sheets |
| Phone (landscape) | Split: agent list + active view | Ionic split-pane |
| iPad / Tablet | Multi-pane: agent rail + projection log + detail view | CSS Grid + container queries |
| Desktop browser | Dense cockpit panels, like an instrument console | Same components, different CSS |

The same projection stream and command gateway serve all form factors. The layout changes; the control plane does not.

### Why Not Framework7 or Material Web

**Framework7** produces polished mobile app-like UIs, but its visual personality is strong — "simulated native app." A devtool dashboard should feel like Tribunus, not an iOS clone. The same concern applies at a lower intensity with Ionic, which is why Ionic is confined to the touch shell layer, not the component design system.

**Material Web** (Google) is in maintenance mode as of 2026, pending new maintainers. That is an unacceptable signal for a product whose UI system must age well. Material 3 aesthetics would also give Tribunus a Google-product feel rather than a cockpit-product feel.

### The Rule

> Do not let Ionic own the architecture. The Tribunus projection model owns the architecture. Ionic supplies touch primitives. Tribunus components bind to projection deltas and emit command intents. The domain design system is Tribunus cockpit components, not a mobile app template.
## References
- Web Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- Service Workers: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- Apple Web Push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- ADR 003: PGlite + Valkey + DuckDB Data Architecture
- ADR 004: Valkey as Coordination Kernel
