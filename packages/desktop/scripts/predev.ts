import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`

// Copy PGlite WASM/data assets so the electron sidecar can load them
await $`cp ../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.data ../opencode/dist/node/ 2>/dev/null || true`
await $`cp ../node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/postgres.wasm ../opencode/dist/node/ 2>/dev/null || true`


// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`
