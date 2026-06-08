# Repository Rename and Domain Cutover Walkthrough

Start from the user-facing surfaces. Update public docs, repo links, and product routes so they point at `tribunus-dev/tribunus` and `tribunus.dev`. Keep Zen-only references intact when they are clearly naming the external provider or its auth and billing flow.

The public site should treat `/community` as the canonical community route, `/discussions` as an alias, and `/issues` as the stable issue route. GitHub-native destinations can still point directly to the GitHub Discussions or Issues pages when the surface is explicitly GitHub-native.

The repo rename and the `tribunus.dev` Pages custom domain still need external confirmation. Treat DNS, HTTPS enforcement, and GitHub transfer state as pending until they are verified outside the codebase.

After the code changes land, run the branding guard and the package-local typecheck and tests to confirm the public surfaces still build cleanly.
