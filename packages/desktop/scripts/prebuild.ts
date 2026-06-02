#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`


await $`cd ../opencode && bun script/build-node.ts`

// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`

// PGlite defaults to ./postgres.data relative to the bundled JS;
// pre-create the directory so it doesn't ENOENT on first access.
await $`mkdir -p out/main/chunks/postgres.data`
