import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`


// Copy PGlite WASM/data assets so the electron sidecar can load them
await import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`


cd ../runtime && bun script/build-node.ts`
const repoRoot = (await $`git rev-parse --show-toplevel`.quiet()).text().trim()
const pgliteDir = `${repoRoot}/node_modules/.bun/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist`


// Force fresh build output before electron-vite runs
await $`rm -rf out/main out/renderer out/migration-pg`.quiet()
await $`cp -r ../runtime/migration-pg out/migration-pg`.quiet()