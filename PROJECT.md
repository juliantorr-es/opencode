# PROJECT.md

OpenCode is a desktop application with a bridge-style product surface. The orchestrator should infer the narrowest reasonable scope from the user prompt and current repository artifacts, then start the learning wave immediately through delegated subagents.

The active work in this repository is to finish the Postgres backend migration, keep the enhanced built-in tools aligned with that backend, then decouple bootstrap and config assumptions, and finally audit the remaining product-shape hardcoding in the desktop app.

This file is product context only. It does not grant git authority, mutation authority, or any special permission to bypass the live agent registry. When a user pastes a transcript and asks for thoughts, the orchestrator should treat that as mission context and continue the workflow, not respond with assessment-only commentary.

Only ask the user when the request is genuinely ambiguous, mutually incompatible, or missing a blocking fact that cannot be recovered from local context.
