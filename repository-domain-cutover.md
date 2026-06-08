# Tribunus Repository and Domain Cutover Report

This document tracks the repository rename, custom domain cutover, and the boundary between Tribunus-owned surfaces and preserved OpenCode upstream references.

## Status

| Item | Status | Notes |
| --- | --- | --- |
| `CODE_LINKS_UPDATED` | COMPLETED | Product-facing repository, docs, and metadata links now point at `tribunus-dev/tribunus` and `tribunus.dev` where the surface is Tribunus-owned. |
| `PRODUCT_ROUTE_UPDATED_TO_TRIBUNUS_DEV` | COMPLETED | Public site routes now include `tribunus.dev/community`, `tribunus.dev/discussions`, and `tribunus.dev/issues` as product-facing entry points. |
| `GITHUB_NATIVE_METADATA_UPDATED` | COMPLETED | GitHub-native destinations now point at the `tribunus-dev/tribunus` repository where appropriate. |
| `UPSTREAM_REFERENCE_PRESERVED` | COMPLETED | OpenCode Zen, upstream SDK dependencies, and attribution-only references remain intact. |
| `MANUAL_REPO_RENAME_PENDING` | PENDING | GitHub transfer or rename still needs external confirmation. |
| `DNS_HTTPS_VALIDATION_PENDING` | PENDING | `tribunus.dev` DNS and GitHub Pages HTTPS validation still need external verification. |

## External Actions

The repository target is `https://github.com/tribunus-dev/tribunus`, but the GitHub rename or transfer still has to be confirmed in GitHub settings or via the GitHub API. Until that happens, the local remote update is a preparatory step, not proof of completion.

The public site target is `https://tribunus.dev`. GitHub Pages custom domain setup still requires the repository Pages configuration, DNS records, and HTTPS enforcement to be validated externally. A code or CNAME change alone is not enough to mark that cutover complete.

OpenCode Zen stays in the upstream-provider bucket only. Keep references to `opencode.ai/zen`, `opencode.ai/auth`, and related billing or model-routing flows only where the surface is clearly talking about the external provider, not Tribunus-owned infrastructure.
