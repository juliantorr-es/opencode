export type MarkdownFactV1 = {
  headings: Array<{ level: number; text: string; line: number }>
  summary?: string
}

export function parseMarkdownFacts(text: string): MarkdownFactV1 {
  const headings = text
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/)
      if (!match) return null
      return { level: match[1]!.length, text: match[2]!, line: index + 1 }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  return { headings, summary: headings[0]?.text }
}
