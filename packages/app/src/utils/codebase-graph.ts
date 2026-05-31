// Static package graph model for the codebase map visualization

export interface PackageGraphNode {
  id: string
  label: string
  path: string
  color: string
  children?: PackageGraphNode[]
  fileCount?: number
}

export interface PackageGraphLink {
  source: string
  target: string
  type: "depends" | "import"
}

export interface PackageGraph {
  nodes: PackageGraphNode[]
  links: PackageGraphLink[]
}

// Curated colors for each package
const PACKAGE_COLORS: Record<string, string> = {
  core: "#4A90D9",
  opencode: "#E67E22",
  app: "#2ECC71",
  desktop: "#9B59B6",
  ui: "#E74C3C",
  llm: "#1ABC9C",
  plugin: "#F39C12",
  sdk: "#3498DB",
  enterprise: "#E91E63",
  console: "#00BCD4",
  web: "#FF5722",
  slack: "#8BC34A",
  script: "#607D8B",
  "http-recorder": "#795548",
  function: "#FF9800",
  storybook: "#673AB7",
}

const WORKSPACE_PACKAGES = [
  { id: "core", label: "@opencode-ai/core", path: "packages/core" },
  { id: "opencode", label: "@opencode-ai/opencode", path: "packages/opencode", children: [
    { id: "opencode-session", label: "session", path: "packages/opencode/src/session" },
    { id: "opencode-tool", label: "tool", path: "packages/opencode/src/tool" },
    { id: "opencode-server", label: "server", path: "packages/opencode/src/server" },
    { id: "opencode-storage", label: "storage", path: "packages/opencode/src/storage" },
    { id: "opencode-config", label: "config", path: "packages/opencode/src/config" },
    { id: "opencode-coordination", label: "coordination", path: "packages/opencode/src/coordination" },
    { id: "opencode-bus", label: "bus", path: "packages/opencode/src/bus" },
  ]},
  { id: "app", label: "@opencode-ai/app", path: "packages/app", children: [
    { id: "app-components", label: "components", path: "packages/app/src/components" },
    { id: "app-pages", label: "pages", path: "packages/app/src/pages" },
    { id: "app-context", label: "context", path: "packages/app/src/context" },
  ]},
  { id: "desktop", label: "@opencode-ai/desktop", path: "packages/desktop", children: [
    { id: "desktop-main", label: "main", path: "packages/desktop/src/main" },
    { id: "desktop-renderer", label: "renderer", path: "packages/desktop/src/renderer" },
    { id: "desktop-preload", label: "preload", path: "packages/desktop/src/preload" },
  ]},
  { id: "ui", label: "@opencode-ai/ui", path: "packages/ui", children: [
    { id: "ui-components", label: "components", path: "packages/ui/src/components" },
    { id: "ui-v2", label: "v2", path: "packages/ui/src/v2" },
  ]},
  { id: "llm", label: "@opencode-ai/llm", path: "packages/llm" },
  { id: "plugin", label: "@opencode-ai/plugin", path: "packages/plugin" },
  { id: "sdk", label: "@opencode-ai/sdk", path: "packages/sdk/js" },
  { id: "enterprise", label: "@opencode-ai/enterprise", path: "packages/enterprise" },
  { id: "console", label: "@opencode-ai/console", path: "packages/console/app" },
  { id: "web", label: "@opencode-ai/web", path: "packages/web" },
  { id: "slack", label: "@opencode-ai/slack", path: "packages/slack" },
  { id: "http-recorder", label: "@opencode-ai/http-recorder", path: "packages/http-recorder" },
  { id: "function", label: "@opencode-ai/function", path: "packages/function" },
  { id: "storybook", label: "Storybook", path: "packages/storybook" },
  { id: "script", label: "@opencode-ai/script", path: "packages/script" },
]

// Known dependency links between packages
const KNOWN_LINKS: PackageGraphLink[] = [
  { source: "opencode", target: "core", type: "depends" },
  { source: "app", target: "core", type: "depends" },
  { source: "app", target: "ui", type: "depends" },
  { source: "app", target: "sdk", type: "depends" },
  { source: "desktop", target: "app", type: "depends" },
  { source: "desktop", target: "ui", type: "depends" },
  { source: "ui", target: "core", type: "depends" },
  { source: "ui", target: "sdk", type: "depends" },
  { source: "enterprise", target: "core", type: "depends" },
  { source: "enterprise", target: "ui", type: "depends" },
  { source: "plugin", target: "sdk", type: "depends" },
  { source: "console", target: "core", type: "depends" },
  { source: "console", target: "ui", type: "depends" },
  { source: "llm", target: "core", type: "depends" },
]

function colorOf(id: string): string {
  return PACKAGE_COLORS[id] ?? "#888"
}

function buildNode(pkg: typeof WORKSPACE_PACKAGES[number]): PackageGraphNode {
  return {
    id: pkg.id,
    label: pkg.label,
    path: pkg.path,
    color: colorOf(pkg.id),
    children: pkg.children?.map(buildNode),
  }
}

export function buildPackageGraph(): PackageGraph {
  return {
    nodes: WORKSPACE_PACKAGES.map(buildNode),
    links: KNOWN_LINKS,
  }
}

/** Given a file path, determine which package it belongs to. */
export function resolvePackage(path: string): string | null {
  const match = path.match(/^packages\/([^/]+)/)
  if (!match) return null
  const pkgName = match[1]
  // Map directory name to graph ID
  const dirToId: Record<string, string> = {
    core: "core", opencode: "opencode", app: "app",
    desktop: "desktop", ui: "ui", llm: "llm",
    plugin: "plugin", sdk: "sdk", enterprise: "enterprise",
    web: "web", slack: "slack", script: "script",
    "http-recorder": "http-recorder",
    function: "function", storybook: "storybook",
    console: "console",
  }
  return dirToId[pkgName] ?? null
}
