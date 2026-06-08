# Public Release Blocker Register

This register tracks what still blocks a clean public release after the repository and domain cutover.

| Blocker | Status | Notes |
| --- | --- | --- |
| `DOCS_CUSTOM_DOMAIN_PENDING` | PENDING | The docs route should point at `tribunus.dev`, but DNS and Pages validation still need external confirmation. |
| `ISSUE_REPO_PATH_BRAND_PENDING` | COMPLETED | Product-facing issue links now use `tribunus.dev/issues` or the canonical `tribunus-dev/tribunus` issue target. |
| `COMMUNITY_REPO_PATH_BRAND_PENDING` | COMPLETED | Product-facing community links now use `tribunus.dev/community`, `tribunus.dev/discussions`, or the canonical GitHub Discussions target. |
| `DNS_HTTPS_VALIDATION_PENDING` | PENDING | `tribunus.dev` still needs real DNS and HTTPS verification. |
| `MANUAL_REPO_RENAME_PENDING` | PENDING | GitHub repo rename or transfer still needs external confirmation. |
| `CLI_TRIBUNUS_PRIMARY_OPENCODE_DEPRECATED` | OPEN | Compatibility aliases still exist where required. |
| `TRIBUNUS_CONFIG_PRIMARY_OPENCODE_DEPRECATED` | OPEN | Config filenames and legacy environment names remain compatibility surfaces. |
| `PROTOCOL_HEADER_RENAME_DECISION` | OPEN | No protocol rename has been authorized. |
| `SOURCE_LAYOUT_RENAME_DECISION` | OPEN | Source tree rename is still deferred. |
| `PACKAGE_PUBLISHING_IDENTITY` | OPEN | Package publishing identity still follows the current upstream-compatible names. |
| `LEGAL_ATTRIBUTION_REVIEW` | OPEN | Attribution and NOTICE content stay preserved. |

The release is not blocked by the CNAME or code link updates alone. It remains blocked until the repo rename and domain validation are verified externally.
