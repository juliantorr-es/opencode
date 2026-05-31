import { describe, expect, test } from "bun:test"
import { resolveKey } from "./resolve"

const base = {
  "github.login": "Sign in with GitHub",
  "common.ok": "OK",
  "common.cancel": "Cancel",
}

const zh = {
  "common.ok": "确定",
  "common.cancel": "取消",
}

const zht = {
  "common.ok": "確定",
}

describe("locale fallback chain", () => {
  test("returns from current dict when key exists", () => {
    expect(resolveKey("common.ok", zh, undefined, base)).toBe("确定")
  })

  test("falls back to parent dict when key missing from current", () => {
    expect(resolveKey("common.cancel", zht, zh, base)).toBe("取消")
  })

  test("falls back to base when key missing from current and no parent", () => {
    expect(resolveKey("github.login", zh, undefined, base)).toBe("Sign in with GitHub")
  })

  test("falls back to base when key missing from current and parent", () => {
    expect(resolveKey("github.login", zht, zh, base)).toBe("Sign in with GitHub")
  })

  test("returns raw key when missing from all dicts", () => {
    expect(resolveKey("nonexistent.key", zh, undefined, base)).toBe("nonexistent.key")
  })

  test("returns from base directly for en locale", () => {
    expect(resolveKey("common.ok", base, undefined, base)).toBe("OK")
  })

  test("handles template params in fallback", () => {
    expect(
      resolveKey("welcome", undefined, undefined, { welcome: "Hello, {{ name }}!" }, { name: "World" }),
    ).toBe("Hello, World!")
  })

  test("uses current dict over parent dict when both have the key", () => {
    const parent = { "common.cancel": "parent-cancel" }
    expect(resolveKey("common.cancel", zh, parent, base)).toBe("取消")
  })
})
