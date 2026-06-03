#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`



await $`rm -rf out`
await $`cd ../opencode && bun script/build-node.ts`
// Copy pglite .data and .wasm assets into the opencode node dist
// so the copy-server-assets electron-vite plugin bundles them into out/main/chunks
await $`cp ../../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.data ../opencode/dist/node/`
await $`cp ../../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.wasm ../opencode/dist/node/`
await $`mkdir -p out/main/chunks/postgres.data`
await $`cp -r ../opencode/migration-pg out/migration-pg`



