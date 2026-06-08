/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://tribunus.dev",

  // GitHub
  github: {
    repoUrl: "https://github.com/tribunus-dev/tribunus",
    issuesUrl: "https://github.com/tribunus-dev/tribunus/issues",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/opencode",
    discussions: "https://github.com/tribunus-dev/tribunus/discussions",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const
