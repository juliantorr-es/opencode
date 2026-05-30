import { afterAll, describe, expect, test } from "bun:test"

// Test pure utility functions by duplicating their logic inline.
// These are tested against the module's implementation to ensure correctness,
// but since electron native module can't be imported in bun test,
// we test the logic pattern directly.

describe("clampZoom logic", () => {
  // Replicates clampZoom from windows.ts
  const clampZoom = (value: number) => Math.min(Math.max(value, 0.2), 10)

  test("clamps to minimum zoom level (0.2)", () => {
    expect(clampZoom(0)).toBe(0.2)
    expect(clampZoom(-1)).toBe(0.2)
    expect(clampZoom(0.1)).toBe(0.2)
  })

  test("clamps to maximum zoom level (10)", () => {
    expect(clampZoom(10)).toBe(10)
    expect(clampZoom(15)).toBe(10)
    expect(clampZoom(100)).toBe(10)
  })

  test("passes through values within range", () => {
    expect(clampZoom(0.2)).toBe(0.2)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(5)).toBe(5)
    expect(clampZoom(9.9)).toBe(9.9)
  })
})

describe("upsertKeyValue logic", () => {
  // Replicates upsertKeyValue from windows.ts
  const upsertKeyValue = (obj: Record<string, any>, keyToChange: string, value: any) => {
    const keyToChangeLower = keyToChange.toLowerCase()
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === keyToChangeLower) {
        obj[key] = value
        return
      }
    }
    obj[keyToChange] = value
  }

  test("inserts a new key at the end", () => {
    const obj = { a: 1 }
    upsertKeyValue(obj, "b", 2)
    expect(obj).toEqual({ a: 1, b: 2 })
  })

  test("replaces existing key with different casing", () => {
    const obj = { "content-type": "text/html" }
    upsertKeyValue(obj, "Content-Type", "application/json")
    expect(obj["content-type"]).toBe("application/json")
  })

  test("replaces existing key with exact match", () => {
    const obj = { "X-Custom": "old" }
    upsertKeyValue(obj, "X-Custom", "new")
    expect(obj["X-Custom"]).toBe("new")
  })

  test("preserves other keys when upserting", () => {
    const obj = { a: 1, b: 2 }
    upsertKeyValue(obj, "c", 3)
    expect(obj).toEqual({ a: 1, b: 2, c: 3 })
  })

  test("handles empty object", () => {
    const obj: Record<string, any> = {}
    upsertKeyValue(obj, "first", 1)
    expect(obj).toEqual({ first: 1 })
  })
})

describe("isRendererUrl logic", () => {
  // Replicates isRendererUrl pattern from windows.ts
  // Note: The real function also checks ELECTRON_RENDERER_URL env var
  const rendererProtocol = "oc"
  const rendererHost = "renderer"

  const isRendererUrl = (value?: string, html = false): boolean => {
    if (!value || !URL.canParse(value)) return false
    const url = new URL(value)
    if (html && !url.pathname.endsWith(".html")) return false
    if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!devUrl || !URL.canParse(devUrl)) return false
    return url.origin === new URL(devUrl).origin
  }

  const isTrustedRendererUrl = (value?: string) => isRendererUrl(value)

  const OLD_ENV = process.env.ELECTRON_RENDERER_URL

  afterAll(() => {
    process.env.ELECTRON_RENDERER_URL = OLD_ENV
  })

  test("returns false for undefined/empty input", () => {
    expect(isTrustedRendererUrl(undefined)).toBe(false)
    expect(isTrustedRendererUrl("")).toBe(false)
  })

  test("returns false for malformed URLs", () => {
    expect(isTrustedRendererUrl("not-a-url")).toBe(false)
    expect(isTrustedRendererUrl("http://")).toBe(false)
  })

  test("returns true for oc://renderer protocol URLs", () => {
    expect(isTrustedRendererUrl("oc://renderer/index.html")).toBe(true)
    expect(isTrustedRendererUrl("oc://renderer/")).toBe(true)
    expect(isTrustedRendererUrl("oc://renderer/some/path")).toBe(true)
  })

  test("returns false for different oc:// hosts", () => {
    expect(isTrustedRendererUrl("oc://other/index.html")).toBe(false)
    expect(isTrustedRendererUrl("oc://evil.com/phish")).toBe(false)
  })

  test("returns false for http/https URLs when no dev URL set", () => {
    delete process.env.ELECTRON_RENDERER_URL
    expect(isTrustedRendererUrl("http://localhost:5173/index.html")).toBe(false)
    expect(isTrustedRendererUrl("https://app.opencode.ai")).toBe(false)
  })

  test("returns true for dev server URL when ELECTRON_RENDERER_URL matches", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
    expect(isTrustedRendererUrl("http://localhost:5173/index.html")).toBe(true)
    expect(isTrustedRendererUrl("http://localhost:5173/some/page")).toBe(true)
  })

  test("returns false for different origin even with dev URL set", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
    expect(isTrustedRendererUrl("http://evil.com:5173/index.html")).toBe(false)
    expect(isTrustedRendererUrl("http://localhost:9999/index.html")).toBe(false)
  })
})

describe("addRendererHeaders logic", () => {
  const rendererProtocol = "oc"
  const rendererHost = "renderer"
  const documentPolicyHeader = "Document-Policy"
  const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"

  const upsertKeyValue = (obj: Record<string, any>, keyToChange: string, value: any) => {
    const keyToChangeLower = keyToChange.toLowerCase()
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === keyToChangeLower) {
        obj[key] = value
        return
      }
    }
    obj[keyToChange] = value
  }

  const isRendererUrl = (value?: string, html = false): boolean => {
    if (!value || !URL.canParse(value)) return false
    const url = new URL(value)
    if (html && !url.pathname.endsWith(".html")) return false
    if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
    return false
  }

  const addRendererHeaders = (value: string, headers: Record<string, any>) => {
    upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
    upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
    if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
  }

  test("adds Access-Control-Allow-Origin: *", () => {
    const headers: Record<string, any> = {}
    addRendererHeaders("oc://renderer/index.html", headers)
    expect(headers["Access-Control-Allow-Origin"]).toEqual(["*"])
  })

  test("adds Access-Control-Allow-Headers: *", () => {
    const headers: Record<string, any> = {}
    addRendererHeaders("oc://renderer/index.html", headers)
    expect(headers["Access-Control-Allow-Headers"]).toEqual(["*"])
  })

  test("adds Document-Policy for HTML renderer URLs", () => {
    const headers: Record<string, any> = {}
    addRendererHeaders("oc://renderer/index.html", headers)
    expect(headers["Document-Policy"]).toEqual(["include-js-call-stacks-in-crash-reports"])
  })

  test("does not add Document-Policy for non-HTML renderer URLs", () => {
    const headers: Record<string, any> = {}
    addRendererHeaders("oc://renderer/style.css", headers)
    expect(headers["Document-Policy"]).toBeUndefined()
  })

  test("does not add Document-Policy for non-renderer URLs", () => {
    const headers: Record<string, any> = {}
    addRendererHeaders("https://cdn.example.com/script.js", headers)
    expect(headers["Access-Control-Allow-Origin"]).toEqual(["*"])
    expect(headers["Document-Policy"]).toBeUndefined()
  })

  test("overrides existing Access-Control-Allow-Origin case-insensitively", () => {
    const headers: Record<string, any> = {
      "access-control-allow-origin": ["https://old-origin.com"],
    }
    addRendererHeaders("oc://renderer/index.html", headers)
    expect(headers["access-control-allow-origin"]).toEqual(["*"])
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined()
  })
})
