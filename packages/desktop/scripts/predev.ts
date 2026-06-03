import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`

// Copy PGlite WASM/data assets so the electron sidecar can load them
const repoRoot = (await $`git rev-parse --show-toplevel`.quiet()).text().trim()
await $`find ${repoRoot}/node_modules/.bun -name "postgres.data" -path "*pglite*" -exec cp {} ../opencode/dist/node/ \\;`.quiet()
await $`find ${repoRoot}/node_modules/.bun -name "postgres.wasm" -path "*pglite*" -exec cp {} ../opencode/dist/node/ \\;`.quiet()


// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`
