/**
 * Read-only codex browser — public knowledge browsing.
 *
 * Displays architecture decisions (ADRs), research packets, and
 * implementation specs in a searchable, filterable list.
 *
 * Security:
 *  - Read-only: no add/edit/delete operations exposed.
 *  - All data is demo/static content served with the page.
 *  - No backend, filesystem, or local network access.
 */

import {
  createSignal,
  createMemo,
  type JSX,
} from "solid-js"

/* ── Types ────────────────────────────────────────────────────── */

export interface CodexPage {
  id: string
  title: string
  excerpt: string
  tags: string[]
  updated: string
}

export interface CodexBrowserProps {
  pages: CodexPage[]
}

/* ── Component ────────────────────────────────────────────────── */

export function CodexBrowser(props: CodexBrowserProps): JSX.Element {
  const [searchQuery, setSearchQuery] = createSignal("")
  const [activeTag, setActiveTag] = createSignal<string | null>(null)

  const allTags = createMemo(() => {
    const tagSet = new Set<string>()
    for (const page of props.pages) {
      for (const tag of page.tags) {
        tagSet.add(tag)
      }
    }
    return Array.from(tagSet).sort()
  })

  const filteredPages = createMemo(() => {
    const query = searchQuery().toLowerCase().trim()
    const tag = activeTag()

    return props.pages.filter((page) => {
      if (tag && !page.tags.includes(tag)) return false
      if (query) {
        return (
          page.title.toLowerCase().includes(query) ||
          page.excerpt.toLowerCase().includes(query) ||
          page.tags.some((t) => t.toLowerCase().includes(query))
        )
      }
      return true
    })
  })

  return (
    <div
      style={{
        background: "var(--c-surface-card)",
        border: "1px solid var(--c-border-light)",
        "border-radius": "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      {/* Search & filter bar */}
      <div
        style={{
          padding: "16px 20px",
          "border-bottom": "1px solid var(--c-border-light)",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
          }}
        >
          <span style={{ color: "var(--c-text-weak)", "font-size": "0.875rem" }}>&#128270;</span>
          <input
            type="text"
            value={searchQuery()}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            placeholder="Search codex…"
            style={{
              flex: 1,
              padding: "8px 12px",
              background: "var(--c-surface)",
              border: "1px solid var(--c-border)",
              "border-radius": "var(--radius-md)",
              color: "var(--c-text)",
              "font-family": "var(--font-sans)",
              "font-size": "0.8125rem",
              outline: "none",
              transition: "border-color 0.2s",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: "6px",
            "flex-wrap": "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            style={{
              padding: "3px 10px",
              "border-radius": "var(--radius-full, 9999px)",
              border: "none",
              "font-size": "0.6875rem",
              "font-family": "var(--font-mono)",
              cursor: "pointer",
              background: activeTag() === null ? "var(--c-primary)" : "var(--c-surface-alt)",
              color: activeTag() === null ? "#fff" : "var(--c-text-weak)",
              transition: "background 0.15s",
            }}
          >
            All
          </button>
          {allTags().map((tag) => (
            <button
              type="button"
              onClick={() => setActiveTag(tag === activeTag() ? null : tag)}
              style={{
                padding: "3px 10px",
                "border-radius": "var(--radius-full, 9999px)",
                border: "none",
                "font-size": "0.6875rem",
                "font-family": "var(--font-mono)",
                cursor: "pointer",
                background: activeTag() === tag ? "var(--c-primary)" : "var(--c-surface-alt)",
                color: activeTag() === tag ? "#fff" : "var(--c-text-weak)",
                transition: "background 0.15s",
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Page list */}
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
        }}
      >
        {filteredPages().length === 0 ? (
          <div
            style={{
              padding: "40px 20px",
              "text-align": "center",
              color: "var(--c-text-weak)",
              "font-size": "0.875rem",
            }}
          >
            No matching pages found.
          </div>
        ) : (
          filteredPages().map((page) => (
            <div
              style={{
                padding: "16px 20px",
                "border-bottom": "1px solid var(--c-border-light)",
                transition: "background 0.15s",
                cursor: "default",
              }}
              onmouseenter={(e) => {
                ;(e.currentTarget as HTMLElement).style.background = "var(--c-surface)"
              }}
              onmouseleave={(e) => {
                ;(e.currentTarget as HTMLElement).style.background = "transparent"
              }}
            >
              <div
                style={{
                  display: "flex",
                  "justify-content": "space-between",
                  "align-items": "flex-start",
                  gap: "12px",
                }}
              >
                <div>
                  <h4
                    style={{
                      "font-size": "0.9375rem",
                      "font-weight": 600,
                      color: "var(--c-text)",
                      margin: 0,
                    }}
                  >
                    {page.title}
                  </h4>
                  <p
                    style={{
                      "font-size": "0.8125rem",
                      color: "var(--c-text-muted)",
                      margin: "4px 0 0",
                      "line-height": "1.5",
                    }}
                  >
                    {page.excerpt}
                  </p>
                </div>
                <span
                  style={{
                    "font-size": "0.6875rem",
                    color: "var(--c-text-weak)",
                    "white-space": "nowrap",
                    flex: "0 0 auto",
                  }}
                >
                  {page.updated}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  "flex-wrap": "wrap",
                  "margin-top": "8px",
                }}
              >
                {page.tags.map((tag) => (
                  <span
                    style={{
                      padding: "1px 7px",
                      "border-radius": "var(--radius-sm)",
                      background: "var(--c-surface-alt)",
                      color: "var(--c-text-weak)",
                      "font-size": "0.6875rem",
                      "font-family": "var(--font-mono)",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer count */}
      <div
        style={{
          padding: "10px 20px",
          "border-top": "1px solid var(--c-border-light)",
          "font-size": "0.75rem",
          color: "var(--c-text-weak)",
          display: "flex",
          "justify-content": "space-between",
        }}
      >
        <span>
          {filteredPages().length} of {props.pages.length} pages
        </span>
        <span>Read-only &bull; Demo data</span>
      </div>
    </div>
  )
}
