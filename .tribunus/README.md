# .tribunus

This directory contains project-level configuration for Tribunus.
It defines workflows, policies, agent profiles, and tool definitions
for this repository.

## What belongs here
- config.json — project config
- workflows/ — workflow presets
- policies/ — path, tool, and sandbox policies
- agents/ — agent profile overrides
- gates/ — release/security gate definitions

## What does NOT belong here
- Secrets, tokens, API keys — stored in appData (OS keychain)
- Databases, logs, caches — stored in appData
- Runtime state — stored in appData
- Machine-specific paths — stored in appData

## Trust
Declarative JSON config is loaded automatically.
Executable code (plugin.ts, tools/*.ts) requires workspace trust.
