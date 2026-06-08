# Tribunus Cutover Task

The current mission is the repository rename and custom domain cutover from OpenCode to Tribunus while keeping upstream OpenCode Zen references only where they belong to the external provider flow.

The codebase should use `tribunus-dev/tribunus` and `tribunus.dev` for product-facing routes, docs, and metadata. The repository rename and the GitHub Pages custom domain still need external verification, so `MANUAL_REPO_RENAME_PENDING` and `DNS_HTTPS_VALIDATION_PENDING` stay open until those checks happen outside the repo.

The remaining work is to keep tightening the deprecation boundary, run the branding guard, and verify the package-local app and desktop typechecks after the link updates land.
