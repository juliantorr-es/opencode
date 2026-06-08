# ADR 0018: SDK and Plugin Architecture — Governed Runtime Contract

## Status
Accepted — June 2026

## Context

Tribunus requires a stable public contract for external tools, extensions, agents, project spaces, and eventual federation. The existing architecture establishes PGlite as durable truth (ADR 003), Valkey as coordination kernel (ADR 004), and a Cell-based federation model (ADR 014). OpenCode has an agent-control SDK. Tribunus needs a different boundary: a runtime-contract client that exposes semantic operations without exposing PGlite/Valkey/DuckDB implementation. The plugin system must be capability-scoped with governed authority, never ambient access. The Developer Graph (ADR 017) uses AT Protocol DIDs for portable identity. The Cell model (ADR 014) aligns with UCAN scoped authority. The event-sourced graph pattern is used throughout the Tribunus architecture.

**This ADR is an ARCHITECTURE SPINE, not an implementation contract.** It defines the strategic boundary and major components. Concrete schemas, lifecycles, and process models will be specified in follow-up artifacts (Plugin Runtime Contract v1, Extension Trust Kernel v1).

## Decision

### SDK Thesis

The Tribunus SDK is the governed interface for interacting with project runtime state. Unlike OpenCode agent-control SDK (which focuses on controlling an agent server), the Tribunus SDK exposes semantic operations that represent the durable coordination spine: create project, open session, enqueue governed work, observe lifecycle, subscribe to receipts, request capability, attach artifact, publish projection, join project room, export audit packet. Internally, these operations may touch PGlite, Valkey, DuckDB, MCP tools, or UI state, but externally they remain stable contracts.

The key distinction: OpenCode SDK is an agent-control client. Tribunus SDK is a runtime-contract client.

### Architecture Layers

#### Layer 0: Internal Runtime Client (Non-Public)

TribunusRuntimeClient is the internal client that uses the protocol package against the local runtime. This is a non-public precursor that proves the protocol contracts before committing to public API ergonomics.

Public packages are: `@tribunus/protocol`, `@tribunus/client`, `@tribunus/plugin`.

#### Layer 1: @tribunus/protocol — Low-Level Schema Package

Foundation package containing all canonical schemas, enums, and contracts that enable the app, SDK, plugins, future mobile client, and federation layer to speak the same language.

**Contents:**
- Event envelopes (federation, plugin, lifecycle)
- Receipt schemas (governance, capability, dharma, audit)
- Lifecycle enums (project state, session state, work item state, gate state)
- Capability descriptors (permission classes, scope definitions, risk levels)
- Work state transitions (valid state machines for all entities)
- Federation object types (envelope formats, signing schemes, validation rules)
- Compatibility codecs (versioning, migration paths, deprecation policies)

**Consumers:** All Tribunus components — app runtime, `@tribunus/client`, `@tribunus/plugin`, mobile PWA, federation services, internal runtime client.

**Implementation Priority:** FIRST. Extract this package before building the full SDK.

#### Layer 2: @tribunus/client — TypeScript SDK for App/Server Control

Equivalent of OpenCode SDK but with Tribunus concepts. Talks to a local or remote Tribunus runtime over HTTP, WebSocket, or RPC.

**Purpose:** Integration surface for IDE plugins, desktop app surfaces, automation scripts, and external tools.

**Design Principles:**
- Semantic operations only — never expose PGlite/Valkey/DuckDB directly
- Transport-agnostic
- Type-safe contracts from `@tribunus/protocol`
- Idempotent operations with receipts
- Error handling with classified error types

#### Layer 3: @tribunus/plugin — Constrained Extension SDK

Enables third parties to add views, commands, tools, project templates, task processors, importers, exporters, or social/project-space features. This layer must be heavily governed.

**Core Principle:** Plugins should not get raw DB access. They should receive capability-scoped handles and emit typed intents.

### Implementation Sequence

1. `@tribunus/protocol` — Extract the protocol package first (PREREQUISITE)
2. Internal `TribunusRuntimeClient` — Build internal client that uses protocol package against local runtime
3. `@tribunus/client` — Create public TypeScript SDK wrapping the internal client
4. `@tribunus/plugin` — Create plugin SDK with capability governance
5. Federation Support — Add federation plugin types after local protocol is stable

**Gate:** The next milestone should be "Protocol Spine v1" as a prerequisite, not "SDK v1".

## Plugin System Design

### Plugin Manifest

Chrome-inspired declarative format, but capability-governed like Tribunus.

**Required Fields:**
- `schema` — tribunus.plugin.manifest.v1
- `id` — com.publisher.plugin-name
- `version`
- `name` — Human-readable name
- `description` — What the plugin does
- `publisher` — id (DID), name, verified status
- `activationEvents` — When the plugin should load
- `contributionPoints` — Commands, views, tools the plugin provides
- `capabilities` — Requests, optional, denied
- `permissions` — Agent invocation mode, data access level
- `trust` — Dharma requirements, review required flag

### Contribution Categories vs Capability Classes

**IMPORTANT DISTINCTION:** Contribution categories describe **WHAT** a plugin contributes. Capability classes describe **WHAT** a plugin is allowed to do. These are independent dimensions.

A UI plugin might request high-risk file access. A Tool plugin might be low-risk if it only formats text. Contribution category is descriptive; capability grants are authoritative.

**Contribution Categories (what a plugin provides):**
1. **Tool Plugins** — Add callable capabilities for agents or users
2. **UI Plugins** — Add panels, tabs, inspectors, project dashboards, artifact viewers, cockpit widgets
3. **Workflow Plugins** — Add templates, project automations, recurring checks, task processors, lifecycle hooks
4. **Data Plugins** — Add importers, exporters, projections, reports, connectors to external systems
5. **Collaboration Plugins** — Add project-space features: rooms, feeds, shared artifacts, identity badges, contribution events, team coordination
6. **Federation Plugins** — Bridge Tribunus project objects into external protocols (should come AFTER local object model is stable)

**Capability Classes (what a plugin can do — defined by runtime policy):**
Initial capability examples include:
- `project.metadata:read`
- `project.files:read`
- `project.files:write`
- `work.propose`
- `work.apply`
- `work.execute`
- `tool.invoke:user`
- `tool.invoke:agent`
- `tool.invoke:auto-scoped`
- `network:<domain-specific>` (e.g., `network:github.com`)
- `secrets:read`
- `shell:execute`
- `artifact:read`
- `artifact:write`
- `artifact:delete`
- `collaboration:read`
- `collaboration:write`

> **Note:** Capability naming grammar will be specified in Plugin Runtime Contract v1. Broad `network:all` access is NOT supported in v1 and should be treated as exceptional or absent. Plugins should request domain-scoped egress only.

### Capability Model

**Principle:** Plugins submit intents; Tribunus decides authority.

A plugin does **NOT** directly write durable state. It asks the runtime to perform a semantic operation. Tribunus validates it, records it, executes it if allowed, emits events, and produces receipts.

This preserves the PGlite/Valkey doctrine: **the SDK never becomes a backdoor around the kernel.**

### Governance Pipeline

1. **Declaration** — Plugin manifest declares requested capabilities
2. **Registration** — Runtime registers plugin and validates manifest
3. **Classification** — Runtime classifies each requested capability by risk level
4. **Policy Evaluation** — Runtime applies workspace trust, user policy, project policy
5. **Grant/Deny** — Runtime grants scoped handles or denies with reason
6. **Runtime Enforcement** — All capability-scoped handles enforce their grants at runtime
7. **Receipt Generation** — Every authority-relevant action produces a durable receipt

### Extension-Host Isolation

Plugins **MUST** run in an isolated extension host process, **NOT** the Electron main process. Plugins **MUST NOT** receive raw DB handles (PGlite, Valkey, DuckDB) or raw filesystem handles. Plugins **MUST** communicate through a message boundary using capability-scoped SDK handles only.

**Enforcement expectations:**
- Plugins execute in separate Extension Host process
- All plugin-runtime communication goes through capability-scoped SDK handles
- No ambient authority: no filesystem, network, secrets, shell without explicit capability grants
- Manifest constraints are validated against all requested capabilities
- Runtime checks enforce current grants on every operation

### Receipts for Plugins

Every authority-relevant plugin action produces a receipt in PGlite:
- Capability request receipt
- Capability grant receipt
- Intent submission receipt
- Intent execution receipt (with results)
- Side effect receipt (external actions)
- Revocation receipt

Receipts include: timestamp, plugin ID, capability, action, input hash, output hash, user approval (if required), policy evaluation results.

## Revocation

Revocation is as important as installation. Tribunus must support runtime revocation for:

- **Packages** — Revoke a specific plugin package by ID
- **Publishers** — Revoke all plugins from a specific publisher
- **Signing Keys** — Revoke plugins signed with a compromised key
- **Versions** — Revoke specific plugin versions
- **Individual Capabilities** — Revoke specific capability grants for a plugin
- **Agent Invocation Rights** — Revoke agent invocation permissions
- **Network/Secrets Access** — Revoke specific high-risk grants

**Revocation semantics:**
- **Immediate** — Capability grants revoked immediately, plugin operations fail
- **Graceful** — Allow existing operations to complete, block new operations
- **Cascade** — Revoke plugin and all dependent plugins/grants
- **Audit** — All revocations produce durable receipts with reason
- **Fanout** — Real-time notification to all affected clients via Valkey Pub/Sub

**Revocation triggers:**
- Security incident detected
- Policy violation
- Publisher request
- User request
- Dharma threshold breach **paired with policy event** (low Dharma alone triggers review/quarantine, not revocation)
- Automated detection (malware, data exfiltration, etc.)

## Invariants

These are ADR-level hard rules that **must never** be violated:

1. **Intent Submission** — Plugins submit intents; Tribunus decides authority. Plugins do **NOT** directly write durable state.
2. **Extension-Host Isolation** — Plugins **MUST** run in isolated extension host process, **NOT** Electron main process. Plugins **MUST NOT** receive raw DB handles or raw filesystem handles. Plugins **MUST** communicate through message boundary using capability-scoped SDK handles only.
3. **Dharma Never Grants Authority** — Dharma **MUST NEVER** grant direct authority. Dharma can only affect friction, visibility, quotas, review routing, and eligibility. Even the highest-Dharma publisher must go through technical enforcement. Dharma changes friction; it does **not** remove confinement.
4. **Auto-Update Authority** — Auto-update **must NOT** silently expand authority. If an installed extension updates and the new version requests new capabilities, new domains, new tool invocation rights, or new secrets access, Tribunus **MUST** require re-grant or policy review.
5. **No Broad Network Access** — Broad `network:all` access is **NOT** supported in v1. Plugins should request domain-scoped egress only. Unrestricted network is treated as high-risk enterprise/admin policy grant.
6. **Dependency Provenance** — Dependency graph lockfiles, checksums, reproducible build metadata, and transitive dependency risk **must** be tracked as part of the trust kernel.
7. **Policy-Driven Enforcement** — Dharma is an input into review routing and trust lanes, but enforcement **must** be policy-driven. Dharma may lower review queue priority risk, but it should **not** be the only reason something is allowed or denied.

## Trust Kernel Security Model

The Trust Kernel is the security enforcement layer parallel to the coordination kernel. It answers: who or what is allowed to do this, under which capability, with what risk, and what accountability trail?

### Four Security Layers (Ordered)

**Layer 1: Technical Confinement** (Non-negotiable)
- Constrained extension host (separate process)
- No raw PGlite access
- No raw Valkey access
- No raw DuckDB access
- No ambient filesystem access
- No unrestricted network access
- No unrestricted secrets access
- No unrestricted shell access
- Plugins only get SDK handles issued by runtime

**Layer 2: Capability Governance**
- Manifest declarations of requested capabilities
- Runtime grants based on policy
- Semantic permissions (not generic)
- User and workspace policy constraints

**Layer 3: Provenance and Accountability**
- Signed packages with stable publisher identity
- Immutable checksums for all releases
- Durable receipts for: package publication, review, install, permission grant, upgrade, invocation, external side effect, revocation
- Dependency graph lockfiles, checksums, reproducible build metadata, transitive dependency risk
- If a plugin does something authority-relevant, there is a durable trail

**Layer 4: Dharma Overlay**
- Event-derived from verified receipts (not popularity or stars)
- Multi-dimensional: Publisher Dharma, Reviewer Dharma, Compute Dharma, Collaboration Dharma, Moderation Dharma, Security Dharma
- Decay mechanisms for stale contributions
- Risk-weighted scoring
- Slashable for malicious behavior
- Can raise/lower: friction, visibility, quota, eligibility
- Dharma is an input into review routing and trust lanes, but enforcement is policy-driven

### Dharma Invariant (ADR-Level Hard Rule)

> **Dharma MUST NEVER grant direct authority.** Dharma can only affect friction, visibility, quotas, review routing, and eligibility. Even the highest-Dharma publisher must go through technical enforcement. Dharma changes friction; it does **not** remove confinement.

### Dharma Earning

Developers earn Dharma when their extension:
- Passes reproducible build checks
- Survives security review
- Receives verified installs with no abuse reports
- Fixes reported vulnerabilities quickly
- Writes useful documentation
- Participates in code review
- Contributes idle inference compute successfully
- Helps triage other extensions

### Dharma Losing

Developers lose Dharma when their extension:
- Ships malware
- Exfiltrates data
- Hides permissions
- Spams project feeds
- Abuses agent tool calls
- Performs unauthorized external side effects
- Has compromised signing key **and demonstrates negligence** (failure to rotate, failure to disclose, malicious use)
- Has vulnerable dependency chain **that is severe, known, ignored, exploited, or concealed**

**Note:** A compromised key or vulnerability alone does not automatically trigger Dharma loss. Containment and review happen first; Dharma loss depends on the maintainer's response and whether negligence or malicious intent is demonstrated.

### Trust Lanes

**Low Trust Lane (New Publishers):**
- Lower visibility in store
- Stricter review process
- Limited capability grants
- No auto-update privileges
- No sensitive API access
- No agent-auto-invocation permissions

**High Trust Lane (Verified Publishers):**
- Faster review
- Broader distribution
- Eligible for verified badges
- Larger quota limits
- Lower friction installs
- **Eligibility to submit** higher-risk extension classes for review

## Extension Store as Trust Ledger

The Tribunus Extension Store is **not** just a marketplace — it is a **trust ledger**. Each listing displays:

**Per-Listing Display:**
- Publisher identity (DID, verified status)
- Package signature and checksum
- Source repository URL
- Reproducible build status
- Dependency risk analysis
- Requested capabilities (semantic, not technical)
- Runtime grants (what was actually approved)
- Install count and trends
- Confirmed incident history
- Unresolved abuse reports
- Audit status and receipts
- Dharma scores by category
- Whether extension has authority to: touch files, access secrets, invoke tools, access network, modify collaboration feeds, contact external services

**Risk Translation:**
Users should **not** have to read code to understand risk. The store translates risk into plain runtime authority.

**Examples:**
- "This extension can read your project metadata"
- "This extension can read source files in /src/**"
- "This extension can propose code changes but cannot apply them"
- "This extension exposes tools that agents may invoke only after approval"
- "This extension can contact github.com"
- "This extension cannot access secrets"
- "This extension writes durable receipts for external actions"

**Dharma Question:**
While technical enforcement answers *"what can this do?"*, Dharma answers: **"Has this actor historically behaved well under similar authority?"**

## MCP Integration Strategy

MCP (Model Context Protocol) is **one** diplomatic protocol that Tribunus speaks, **not** the sole plugin model.

### MCP as Governed Capability Adapter

The MCP Adapter translates MCP tools, resources, and prompts into Tribunus governed capabilities.

**Translation Process:**
1. MCP server registers tools/resources/prompts
2. MCP Adapter creates provisional capability records
3. Policy Compiler evaluates and classifies
4. Governed Capability Store persists canonical schema
5. Runtime executes with receipt generation

**Classification Pipeline:**

| Call Class | Policy | Receipt |
|------------|--------|---------|
| Read-only, deterministic, local | Light receipt, auto-approved | Timestamp + result hash |
| Read-only, non-deterministic | Moderate receipt, logged | Full input/output |
| Mutating, filesystem-only | Full receipt, scoped path check | Full evidence record |
| Mutating, with side effects | Human approval default, heavy receipt | Approval + evidence |
| Secrets, network, shell, payments, deployment, Git mutation | Explicit human authorization, auditable user-intent link | Full governance receipt |

This pipeline gives Tribunus an early risk taxonomy for tool classification.

### Tribunus as MCP Gateway

Tribunus positions itself as an MCP gateway, brokering access to:
- Local tools (filesystem, Git, etc.)
- Remote MCP servers (GitHub, Slack, databases)
- Browser automation
- Agent runtimes

Through **one** governed policy surface. This provides:
- Centralized authentication (OAuth 2.1, PKCE)
- Single endpoint for all tools
- Zero Trust filtering
- Tool schema validation
- Action-level authorization
- Per-call traces and logs
- Audit receipts for every invocation

**Benefit:** Positions Tribunus to integrate with the MCP ecosystem.

## Chrome-Like Extension Shape (Not Compatibility)

Tribunus plugins should feel familiar to developers who have written VS Code extensions, Chrome extensions, or MCP tools. But they should execute **under Tribunus rules**.

### Adopt from Chrome/Electron
- Declarative manifest format
- Explicit permissions
- Extension activation events
- Constrained UI contribution points
- Content-script-like injection for controlled surfaces
- Background workers for long-running coordination
- Reviewable permission prompt

### Avoid from Chrome/Electron
- Chrome extension authority model (browser-oriented)
- Full Chrome Extensions API surface
- Browser-specific authority domains (tabs, cookies, history)
- Ambient authority patterns

**Reason:** Tribunus extensions are **project-runtime oriented**, not browser-oriented.

### Compatibility Lane

Electron's Chrome-extension support can be useful in **one narrow lane**: supporting real DevTools/browser extensions inside the desktop shell for Chrome-compatible inspection, debugging, or controlled browser-surface augmentation.

**This should be a compatibility/adaptation lane, not the Tribunus plugin substrate.**

Electron explicitly states it does not support arbitrary Chrome extensions from the store and that perfect Chrome compatibility is not a goal. Tribunus follows the same principle.

## VS Code Patterns to Adopt

### Adopt
- Extension host process model (separate process for extensions)
- Contribution points architecture (commands, views, languages, debuggers)
- Command registry (palette and keybindings)
- Activation events (`onLanguage`, `onCommand`, `workspaceContains`, etc.)
- Webviews/panels (isolated UI contributions)
- Workspace trust posture (restricted mode for untrusted folders)
- Language tooling through LSP
- Debug/task-provider concepts

### Avoid
- VS Code extension API compatibility as first goal
- Workbench as the app core (Tribunus is runtime-first)
- Editor-first product model
- Marketplace assumptions (centralized store model)

**Reason:** Tribunus is a governed project operating runtime with coding built in. The editor is a powerful surface **inside** that runtime, not the runtime itself.

## Non-Goals

This ADR **explicitly does NOT** commit to:
- Raw PGlite/Valkey/DuckDB access for plugins (plugins receive capability-scoped SDK handles only)
- Chrome Web Store compatibility guarantee (Chrome-like ergonomics yes, full compatibility no)
- VS Code extension API compatibility guarantee in v1 (Tribunus-native API first)
- Dharma bypass of security gates (Dharma affects friction/visibility only, **never** authority)
- Federation extension authority before local protocol stability (local object model must be stable first)
- Ambient filesystem access for plugins (all filesystem access requires explicit capability grants)
- Ambient network access for plugins (all network access requires explicit capability grants; broad `network:all` **not** supported in v1)
- Ambient secrets access for plugins (all secrets access requires explicit capability grants)
- Ambient shell access for plugins (all shell access requires explicit capability grants)

## Follow-Up Specs

This ADR is a **spine**, not a spec. The following concrete specifications should be produced next:

1. **Plugin Runtime Contract v1** — Concrete schemas for: manifest fields, capability names, grant lifecycle, install lifecycle, invocation lifecycle, receipt types, risk levels
2. **Extension Trust Kernel v1** — Concrete schemas for: extension-host process model, capability enforcement, signing requirements, revocation semantics, policy evaluation, dependency provenance
3. **@tribunus/protocol v1** — Canonical TypeScript package with all schemas and contracts
4. **SDK Client Contract v1** — Public API surface for `@tribunus/client`
5. **Plugin SDK Contract v1** — Public API surface for `@tribunus/plugin`

## Consequences

### Positive
1. **Strong Product Boundary** — Tribunus supports governed extensions, not random code running inside the app
2. **Developer Extensibility** — Developers can add tools, views, workflows, connectors, and collaboration features
3. **First-Class Runtime Participants** — Plugins are first-class participants in the governed runtime, not second-class citizens
4. **Clean Evolution Path** — Architecture scales from solo user to small team to enterprise
5. **Interoperability** — Positions Tribunus to integrate with the MCP ecosystem
6. **Portable Identity** — AT Protocol DIDs from day one mean no vendor lock-in
7. **Auditability** — Event-sourced graph and receipts create full audit trail
8. **Authority Alignment** — UCAN scoped authority matches Cell model perfectly
9. **Clear Invariants** — Dharma never bypasses security, plugins submit intents only, extension-host isolation mandatory, auto-update never silently expands authority

### Negative
1. **Complexity** — Multiple layers (protocol, client, plugin, trust kernel) to maintain
2. **Learning Curve** — Capability governance model requires understanding
3. **Performance Overhead** — Extension host process adds memory/CPU overhead
4. **Security Surface Area** — Supply chain risks remain (malicious plugins, compromised dependencies)
5. **Compatibility Limitations** — Chrome/Electron extensions only supported in compatibility lane, not as first-class Tribunus plugins
6. **Enterprise Adoption** — Capability governance may require policy configuration for enterprise deployments

### Mitigations
- Start with protocol package (lowest risk, highest value)
- Implement capability governance incrementally
- Use existing patterns from VS Code/Chrome for familiarity
- Make **public Dharma display and community trust features** opt-in initially; keep security receipts and policy enforcement mandatory
- Provide clear documentation and examples
- Build automated testing for security properties
- Produce follow-up specs before implementation

## Relationship to Existing ADRs

- **ADR 003** (PGlite + Valkey + DuckDB) — SDK exposes semantic operations using this data architecture; PGlite remains authoritative
- **ADR 004** (Valkey Coordination Kernel) — Valkey coordinates plugin work queues, capability grants, and Trust Kernel real-time state
- **ADR 014** (Tribunus Cell Federation) — Plugin system extends Cell authority model; federation plugins bridge Cells
- **ADR 015** (MCP Governed Capabilities) — MCP is one protocol adapter; this ADR defines the broader plugin system that MCP fits into
- **ADR 016** (Sandbox Cell) — Plugin sandbox follows similar isolation principles as repository sandbox
- **ADR 017** (Developer Graph) — Plugin identity uses AT Protocol DIDs; plugin contributions appear in feeds