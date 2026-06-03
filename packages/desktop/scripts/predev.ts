import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`

// Copy PGlite WASM/data assets so the electron sidecar can load them
const repoRoot = (await $`git rev-parse --show-toplevel`.quiet()).text().trim()
const pgliteDir = `${repoRoot}/node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist`
await $`cp ${pgliteDir}/postgres.data ../opencode/dist/node/`.quiet()
await $`cp ${pgliteDir}/postgres.wasm ../opencode/dist/node/`.quiet()


// Force electron-vite dev to rebuild the main chunk by removing stale cache
await $`rm -f out/main/chunks/node-*.js 2>/dev/null || true`.quiet()

// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`