// SQL/JSON analysis — extract table, index, constraint, and view info from SQL DDL
// and parse JSON manifests with safe fallback.

export function analyzeSqlText(text: string): {
  tables: string[];
  indexes: string[];
  constraints: Array<{ table: string; kind: "primary_key" | "foreign_key" | "check" | "unique" | "partial_unique_index" | "index"; expression: string }>;
  views: string[];
} {
  const tables = [...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)].map((m) => m[1].replace(/"/g, ""));
  const indexes = [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)].map((m) => m[1].replace(/"/g, ""));
  const views = [...text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)].map((m) => m[1].replace(/"/g, ""));
  const constraints: Array<{ table: string; kind: "primary_key" | "foreign_key" | "check" | "unique" | "partial_unique_index" | "index"; expression: string }> = [];
  for (const table of tables) {
    const tableBlock = text.split(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))[1] ?? text;
    for (const line of tableBlock.split("\n")) {
      if (/PRIMARY KEY/i.test(line)) constraints.push({ table, kind: "primary_key", expression: line.trim() });
      if (/FOREIGN KEY/i.test(line)) constraints.push({ table, kind: "foreign_key", expression: line.trim() });
      if (/\bCHECK\b/i.test(line)) constraints.push({ table, kind: "check", expression: line.trim() });
      if (/\bUNIQUE\b/i.test(line) && !/CREATE\s+UNIQUE\s+INDEX/i.test(line)) constraints.push({ table, kind: "unique", expression: line.trim() });
    }
  }
  for (const index of indexes) {
    constraints.push({ table: index, kind: "index", expression: index });
  }
  return { tables, indexes, constraints, views };
}

export function analyzeJsonManifest(path: string, text: string): Record<string, any> {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
