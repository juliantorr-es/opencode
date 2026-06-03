# ADR 007: Unified Design Language Across All Surfaces

## Status
Accepted — June 2026

## Context

Tribunus currently has four distinct surfaces, each with its own personality problem:

1. The **GitHub Pages landing page** — a static dark-themed website with the Tribunus brand identity
2. The **desktop macOS app** — inheriting the opencode TUI/desktop architecture, half-assed personality
3. The **mobile PWA cockpit** — planned but not yet built
4. The **tablet dashboard** — a form-factor variant of the PWA

Building each surface independently guarantees visual fragmentation. The desktop app carries inherited opencode styling that doesn't match the landing page. The mobile PWA would bring a third visual grammar. The tablet would be a fourth. This is unsustainable for a product with a strong identity.

## Decision

### One Component System, Four Shells

All four surfaces share one component vocabulary built on **Lit** (Web Components). The components are product-domain concepts, not generic UI primitives:

```
SessionCard    AgentRail    GateRequest    CommandReceipt
ProjectionStream  DharmaScore  QueueItem  CodexNode
DiagnosticPacket  ApprovalSheet  DevicePresence
RelayStatus  TrustBadge  ReceiptTimeline  MissionCard
```

Each component renders compact on phone, split-pane on tablet, and dense on desktop — adapted via CSS Container Queries, not framework-specific responsive logic.

### Shell Strategy

| Surface | Shell | Components |
|---------|-------|------------|
| GitHub Pages (public) | Static HTML + Lit components in demo mode | Same component vocabulary, rendered with simulated projection data |
| Mobile PWA (phone) | Lit components + Ionic touch primitives (selective) | Projection-bound live components |
| Tablet Dashboard (iPad) | Lit components + CSS Grid multi-pane | Same projection-bound components, different layout |
| Desktop App (macOS) | Electron + Lit components | Same projection-bound components, native filesystem access |

The desktop app is not replaced — it remains the execution authority. But its UI surface transitions from inherited opencode screens to Tribunus cockpit components over time.

### Public vs. Authenticated Mode

**Public mode** (GitHub Pages, unauthenticated):
- Landing page rendered with the same components at rest
- Simulated mission timeline, demo receipts, architecture cards
- Codex browser (read-only public knowledge)
- "Ask a question" intake lane → hosted queue → desktop reviews and optionally engages

**Authenticated mode** (paired device):
- Live projection stream from the desktop
- Command gateway active (approve, pause, resume, cancel)
- Real dharma scores, live agent status, active gate requests
- Notification-driven resync

The same component renders differently based on a `mode` attribute — public shows demo data, authenticated binds to the projection stream.

### GitHub Pages as the Unified Host

GitHub Pages hosts the static PWA shell. It serves:

1. The public landing page / marketing site
2. The installable PWA (manifest, service worker, Web Push registration)
3. The paired cockpit (when the user scans a QR code from their desktop)

The PWA shell is static, cacheable, and HTTPS-enforced (required for service workers). Live data flows through the relay, not through GitHub Pages. GitHub Pages is the face; the relay carries the conversation; the desktop keeps the hands.

### The Design System as Forcing Function

The inherited opencode desktop personality is not patched incrementally. The design system is built once, then each surface is migrated to it. New features use the component system. Old screens are replaced as they're touched. The design language defines the product — it is not applied after the fact.

### Public Intake Lane (Not Direct Desktop Access)

Public users submit questions to a hosted queue via a "Ask a question" component on the GitHub Pages site. The desktop subscribes to that queue. A public intake request appears in the cockpit. The operator approves or ignores it. If approved, a scoped session opens — the visitor sees status updates through the web app. At no point does the visitor reach the desktop directly. Raw shell access, filesystem, Valkey, PGlite, and local network are never exposed to public users.

This gives a community layer without turning the computer into a piñata.

## Consequences

### Positive
- **One visual grammar.** Every surface speaks Tribunus. No more inherited opencode personality.
- **Component reuse across all form factors.** Building a component once serves phone, tablet, desktop browser, and native desktop.
- **GitHub Pages as the distribution surface.** No separate hosting, no CDN config, no deploy pipeline — push to gh-pages and the PWA updates.
- **Public mode dogfoods the product.** The landing page IS the cockpit at rest. The demo IS the product.
- **Clean community intake.** Public questions flow through a queue, not into the machine. Safety by design.

### Negative
- **Lit is not Electron-native.** Electron's main/renderer split means Lit components in the renderer process, native Node APIs in the main process. This is standard Electron architecture, but the component system doesn't have direct filesystem or process access — those go through IPC.
- **Two rendering engines during migration.** The desktop app will have both old opencode screens and new Lit components during the transition. This is unavoidable.
- **GitHub Pages is static.** The relay must handle all live features. GitHub Pages serves the shell only. This is architecturally correct but means the relay is mandatory, not optional.
- **Ionic dependency is a pragmatic compromise.** Pure Lit touch components for sheets, modals, and pull-to-refresh would be more work. Ionic shrinks that surface but brings its own visual weight. Mitigation: confine Ionic to the touch shell, never to domain components.

## References
- Lit: https://lit.dev — Web Components framework
- Shoelace: https://shoelace.style — Framework-agnostic Web Components library
- Ionic: https://ionicframework.com — Mobile touch SDK for the web
- GitHub Pages HTTPS: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- Web Push (Apple): https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- ADR 006: Mobile PWA as Remote Cockpit
