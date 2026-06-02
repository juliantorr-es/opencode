import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`

// Copy migration directory so db.pg.ts can resolve it at runtime
await $`rm -rf out/migration-pg && cp -r ../opencode/migration-pg out/migration-pg`

// PGlite defaults to ./postgres.data relative to the bundled JS;
// pre-create the directory so it doesn't ENOENT on first access.
await $`mkdir -p out/main/chunks/postgres.data`
