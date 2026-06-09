# Desktop Release Candidate Qualification

Evidence directory for Tribunus desktop release qualification.

## Directory Structure

- `manifest.schema.ts` — TypeScript interfaces for qualification manifests
- `receipts/` — Machine-generated qualification receipts (JSON)
- `logs/` — Captured logs from qualification runs
- `screenshots/` — Screenshots from critical journeys
- `traces/` — Playwright or performance traces
- `artifacts/` — Generated qualification artifacts

## Release Decision Vocabulary

- **qualified** — Every required gate passed.
- **qualified-with-accepted-risk** — Required gates passed; explicit waivers documented.
- **rejected** — A release-blocking gate failed.
- **incomplete** — Required evidence is absent or untestable artifact.

## Supported Platform Matrix

| Platform | Arch | Support Level | Formats |
|----------|------|--------------|---------|
| macOS | arm64 | fully-supported | dmg, zip |
| macOS | x64 | beta-supported | dmg, zip |
| Windows | x64 | fully-supported | nsis |
| Linux | x64 | beta-supported | appimage, deb, rpm |
