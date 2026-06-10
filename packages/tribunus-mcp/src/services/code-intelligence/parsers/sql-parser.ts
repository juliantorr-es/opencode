export type SqlFactV1 = {
  kind: "table" | "index" | "view" | "migration"
  name: string
  line: number
  text: string
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length
}

export function parseSqlFacts(text: string): SqlFactV1[] {
  const facts: SqlFactV1[] = []
  const patterns: Array<{ kind: SqlFactV1["kind"]; regex: RegExp }> = [
    { kind: "table", regex: /create\s+table\s+if\s+not\s+exists\s+([a-zA-Z0-9_."-]+)/gi },
    { kind: "index", regex: /create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-zA-Z0-9_."-]+)/gi },
    { kind: "view", regex: /create\s+(?:or\s+replace\s+)?view\s+([a-zA-Z0-9_."-]+)/gi },
  ]
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(text))) {
      facts.push({
        kind: pattern.kind,
        name: match[1]!.replace(/[";]/g, ""),
        line: lineOf(text, match.index),
        text: match[0],
      })
    }
  }
  if (facts.length > 0) {
    facts.unshift({ kind: "migration", name: "migration", line: 1, text: text.slice(0, 200) })
  }
  return facts
}
