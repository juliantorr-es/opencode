# Security Policy

## Supported Versions

Tribunus is **pre-alpha** software with no stable release. There is currently no Long-Term Support (LTS) channel or version guarantee. Security fixes are applied to the current development branch (`main`). Users must track `main` or a release tag to receive updates.

| Version          | Supported          |
| ---------------- | ------------------ |
| main (unstable)  | ✅ Active fixes    |
| tagged releases  | ✅ Active fixes    |
| prior alphas     | ❌ Not supported   |

---

## Threat Model

Tribunus is a **desktop application that runs locally on the user's machine**. Its architecture spans multiple processes with distinct security properties. The sections below describe each component's capability, trust boundary, and enforcement level.

Every security claim below is annotated with its current status:

| Status       | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| **enforced** | Mechanically prevented at compile time, process boundary, or capability gate. |
| **detected** | Violation is observable by the system and can be surfaced.                    |
| **audited**  | Violation is logged and can be reviewed post-hoc.                             |
| **advisory** | A UI prompt or warning exists; the user can bypass it deliberately.           |
| **planned**  | A known gap; a fix or hardening item is tracked but not yet implemented.      |
| **unsupported** | Not a claim Tribunus makes. Countermeasures must come from the deployment environment. |

A detailed, evolving document is at [`docs/security/threat-model.md`](docs/security/threat-model.md) (forthcoming).

### 1. Desktop Renderer Process

The renderer process hosts the user interface. It:

- Displays agent output, file diffs, configuration, and chat history. *(enforced)*
- Reads local file content via sandboxed IPC to the main process. *(enforced)*
- Cannot directly execute shell commands, access raw `node` APIs, or spawn child processes. *(enforced via Electron `contextIsolation` and `sandbox: true`)*
- Has no direct network access beyond the origin serving the UI (file:// local assets). *(enforced)*
- Communicates with Electron main through typed IPC channels; the main process validates every request. *(enforced)*

### 2. Electron Main Process

The main process mediates all privileged operations. It:

- Controls window creation, file dialogs, and native OS integration. *(enforced)*
- Hosts tool execution drivers (shell, file write, etc.) that the agent cannot reach directly. *(enforced)*
- Enforces workspace-scoped file read/write permissions. *(enforced)*
- Validates and sanitises IPC messages from the renderer before acting on them. *(enforced)*
- Manages credential resolution (API keys, secrets) from the OS keychain or config. *(detected)*
- Loads MCP server configurations from the user's trusted config directory. *(advisory — the user explicitly configured it)*

### 3. Sidecar / Agent Process

When agent execution requires process isolation (e.g., long-running inference, sandboxed tool evaluation), work may be delegated to a sidecar child process.

- The sidecar is spawned by the main process with a restricted environment. *(enforced)*
- It communicates over stdin/stdout or a dedicated IPC channel scoped to the spawning session. *(enforced)*
- It has no persistent access to the filesystem beyond a scratch directory unless explicitly granted. *(enforced)*
- The sidecar does not hold long-lived credentials; secrets are injected per-call and scoped to the request. *(enforced)*

### 4. Secrets and Credentials

- API keys and secrets are referenced by key name in config; the resolved value is obtained from the OS keychain or environment variable at the point of use. *(detected — secrets are never stored in plain text in config files)*
- Resolution happens in the main process and is passed to the consumer (e.g. an LLM client or MCP server) in-scope for the duration of the call. *(enforced)*
- Secrets are never written to agent-accessible logs or forwarded to the renderer in cleartext. *(detected)*

### 5. Command Execution

- Shell commands are executed in a subprocess spawned by the main process. *(enforced)*
- The user is prompted before execution (the "permission system") unless the command has been previously approved in the same session. *(advisory — the user can approve; intended to prevent accidental execution, not to stop a malicious actor)*
- This is **permission as UX, not OS isolation**. The permission system exists to keep the user informed and to require deliberate confirmation. It is not a sandbox. If you need process-level or kernel-level isolation, run Tribunus inside a VM, container, or dedicated user account. *(unsupported)*

### 6. Tool Mediation

Tools (file read/write, network, shell, MCP) are proxied through the main process, which applies workspace-scoped policies:

- File writes outside the workspace directory are blocked unless explicitly permitted. *(enforced)*
- Network access from tools is permitted to the same origin as the user's configured services. *(enforced — future: planned per-tool allow/deny lists)*
- MCP servers run as separate child processes, spawned by the main process. *(enforced)*

### 7. MCP Servers and Plugins

MCP servers and third-party plugins introduce their own capabilities into the Tribunus trust boundary. The user explicitly adds them to their configuration; Tribunus does not download or install them automatically. *(advisory)*

- MCP server processes inherit no Tribunus credentials. *(enforced)*
- Each MCP server communicates over stdio transport scoped to the agent session. *(enforced)*
- The set of tools an MCP server exposes is visible to the agent; the user controls which servers are configured. *(audited)*
- Tribunus does not audit or vouch for the behaviour of external MCP servers. Their security properties are the user's responsibility. *(unsupported)*

---

## Authentication vs Isolation

- **Authentication** (verifying identity and authorising actions) is an **enforced** concern when it involves credential resolution, IPC validation, and workspace scoping.
- **Process isolation** (preventing one process from tampering with another's memory or execution) is **enforced** at the Electron and OS level: the renderer is sandboxed, the main process validates every IPC call, and sidecar processes run in restricted environments.
- **OS sandboxing** (e.g. seccomp, AppArmor, mandatory access control) is **unsupported**. Tribunus does not install its own kernel-level sandbox. Deploy inside a container or VM for that layer.

---

## Workspace Trust vs Source Trust

- **Workspace trust** is enforced: file operations are scoped to the workspace directory the user opened.
- **Source trust** (whether a code repository, prompt, or package is malicious) is **unsupported**. Tribunus does not analyse the intent of the code it helps edit or execute. The user is responsible for the content they load.

---

## Out of Scope

The following categories are explicitly excluded from the Tribunus security vulnerability programme. Reports in these categories will be closed as informative without further investigation.

| Category                        | Rationale                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- |
| **Server mode (opt-in)**        | If you enable `server` mode, API access is expected behaviour. A password (set via `TRIBUNUS_SERVER_PASSWORD` or equivalent) is required; without it the server prints a warning. The user secures the network layer. |
| **Sandbox escapes**             | The permission system is explicitly documented as UX, not a sandbox (see [Threat Model](#6-tool-mediation)). No sandbox is claimed. |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by that provider's terms and policies. Tribunus cannot enforce provider-side handling. |
| **MCP server behaviour**        | External MCP servers you configure run outside the Tribunus trust boundary. Tribunus does not audit or restrict their internal behaviour. |
| **Malicious local config files** | Users control their own configuration. Modifying `tribunus.jsonc` or similar files is not an attack vector — the user is the administrator of their machine. |
| **Denial of service via resource exhaustion** | Running locally, the app's resource consumption is bounded by the OS; the user can terminate the process. |

---

## Reporting a Security Issue

We appreciate responsible disclosure and will make every effort to acknowledge and triage your report.

To report a security vulnerability, use the GitHub Security Advisory **["Report a Vulnerability"](https://github.com/tribunus-dev/tribunus/security/advisories/new)** tab. This is the preferred channel.

**What to include in your report:**

- A clear description of the vulnerability and the component affected.
- Steps to reproduce — minimal, self-contained, and verifiable.
- Your assessment of impact (e.g., privilege escalation within the app, credential leak, workspace boundary violation).
- Any supporting material (logs, config excerpts, screen captures) **without** embedding credentials or tokens.

**What happens next:**

1. The security team will acknowledge receipt within **6 business days**.
2. We will evaluate the report for validity, impact, and reproducibility.
3. Valid reports will receive a CVE identifier and a timeline for a fix.
4. After a fix is released, we will publish a security advisory describing the issue and the resolution.

**Report quality and disposition:**

- Reports that lack sufficient evidence, cannot be reproduced with the provided steps, or describe behaviour outside the documented threat model may be closed as **informative** or **not applicable**.
- This is not a reflection on the reporter; we simply cannot act on unverifiable claims.
- We do not accept reports generated entirely by AI systems without human verification. If a report appears to be wholly AI-generated with no evidence of human analysis, we will ask the reporter to provide additional technical context before proceeding. We reserve the right to close low-evidence submissions.

If you do not receive an acknowledgement within **6 business days**, you may escalate by emailing **security@tribunus.dev** with the GitHub Advisory ID in the subject line.

---

## Contact

**security@tribunus.dev** — for escalation only after the 6 business day acknowledgement window has passed. Always prefer the GitHub Security Advisory tab for initial reporting.
