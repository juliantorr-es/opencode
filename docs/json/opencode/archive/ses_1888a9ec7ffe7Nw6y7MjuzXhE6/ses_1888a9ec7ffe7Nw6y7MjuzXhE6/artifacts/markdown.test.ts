import { describe, expect, test } from "bun:test"
import { parseMarkdown } from "../src/main/markdown"

describe("parseMarkdown", () => {
  test("renders plain text", () => {
    const result = parseMarkdown("hello world")
    expect(result).toContain("hello world")
  })

  test("renders bold text", () => {
    const result = parseMarkdown("**bold**")
    expect(result).toContain("<strong>bold</strong>")
  })

  test("renders italic text", () => {
    const result = parseMarkdown("*italic*")
    expect(result).toContain("<em>italic</em>")
  })

  test("renders code inline", () => {
    const result = parseMarkdown("text `code` here")
    expect(result).toContain("<code>code</code>")
  })

  test("renders a link with external-link class and target=_blank", () => {
    const result = parseMarkdown("[click](https://example.com)")
    expect(result).toContain('class="external-link"')
    expect(result).toContain('target="_blank"')
    expect(result).toContain('rel="noopener noreferrer"')
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain("click")
  })

  test("renders a link with title attribute", () => {
    const result = parseMarkdown('[click](https://example.com "Example")')
    expect(result).toContain('title="Example"')
  })

  test("renders code block", () => {
    const result = parseMarkdown("```\nconst x = 1\n```")
    expect(result).toContain("<code>")
    expect(result).toContain("const x = 1")
  })

  test("renders paragraph with GFM line break behavior", () => {
    const result = parseMarkdown("line1\n\nline2")
    // GFM: double newline = paragraph break
    expect(result).toContain("<p>")
  })

  test("renders unordered list", () => {
    const result = parseMarkdown("- item 1\n- item 2")
    expect(result).toContain("<ul>")
    expect(result).toContain("<li>item 1</li>")
    expect(result).toContain("<li>item 2</li>")
  })

  test("renders ordered list", () => {
    const result = parseMarkdown("1. first\n2. second")
    expect(result).toContain("<ol>")
    expect(result).toContain("<li>first</li>")
    expect(result).toContain("<li>second</li>")
  })

  test("renders heading", () => {
    const result = parseMarkdown("## Section Title")
    expect(result).toContain("<h2>")
    expect(result).toContain("Section Title")
  })

  test("renders blockquote", () => {
    const result = parseMarkdown("> quoted text")
    expect(result).toContain("<blockquote>")
    expect(result).toContain("quoted text")
  })

  test("handles empty input", () => {
    const result = parseMarkdown("")
    expect(result).toBe("")
  })

  test("renders link with backtick text inside anchor", () => {
    const result = parseMarkdown("[`code` link](https://example.com)")
    // Marked renders the backticks as literal text inside the link
    expect(result).toContain("`code` link")
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain('class="external-link"')
  })
})
