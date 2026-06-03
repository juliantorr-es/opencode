#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`


await $`cd ../opencode && bun script/build-node.ts`

// Copy pglite .data and .wasm assets into the opencode node dist
// so the copy-server-assets electron-vite plugin bundles them into out/main/chunks
await $`cp ../../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.data ../opencode/dist/node/`
await $`cp ../../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.wasm ../opencode/dist/node/`
// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`

// PGlite defaults to ./postgres.data relative to the bundled JS;
// pre-create the directory so it doesn't ENOENT on first access.
await $`mkdir -p out/main/chunks/postgres.data`
