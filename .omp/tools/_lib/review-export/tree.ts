// ─── Review Export Tree ─────────────────────────────────────────────────────

export function buildTree(files: string[]): string {
  const tree: Record<string, unknown> = {};
  // Build nested structure
  for (const f of files) {
    const parts = f.split("/");
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node[part] = null; // leaf
      } else {
        if (!(part in node)) node[part] = {};
        node[part] = node[part] as Record<string, unknown>;
      }
    }
  }

  const lines: string[] = [];
  function render(
    node: Record<string, unknown>,
    indent: string,
    _prefix: string,
  ): void {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = node[a] !== null;
      const bIsDir = node[b] !== null;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isLast = i === keys.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childIndent = isLast ? "    " : "│   ";
      lines.push(`${indent}${connector}${key}`);
      if (node[key] !== null) {
        render(
          node[key] as Record<string, unknown>,
          indent + childIndent,
          "",
        );
      }
    }
  }
  render(tree, "", "");
  return lines.join("\n");
}
