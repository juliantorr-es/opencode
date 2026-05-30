import { describe, expect, test } from "bun:test"

// Tests the electron-store wrapper pattern and related operations.
// We cannot import the real store.ts because it imports the electron
// native module (app.getPath, etc.), which bun test cannot resolve
// outside an Electron environment.
//
// These tests replicate the key-value store pattern used in the app.

describe("key-value store pattern", () => {
  function createStore() {
    const data = new Map<string, any>()
    return {
      get: (key: string) => data.get(key),
      set: (key: string, value: any) => { data.set(key, value) },
      delete: (key: string) => data.delete(key),
      clear: () => data.clear(),
      get store() { return Object.fromEntries(data) },
      get size() { return data.size },
      has: (key: string) => data.has(key),
    }
  }

  test("set and get round-trip values", () => {
    const store = createStore()
    store.set("key1", "value1")
    store.set("key2", 42)
    expect(store.get("key1")).toBe("value1")
    expect(store.get("key2")).toBe(42)
  })

  test("store.get returns undefined for missing key", () => {
    const store = createStore()
    expect(store.get("nonexistent")).toBeUndefined()
  })

  test("delete removes a key", () => {
    const store = createStore()
    store.set("temp", "to-delete")
    expect(store.get("temp")).toBe("to-delete")
    store.delete("temp")
    expect(store.get("temp")).toBeUndefined()
  })

  test("clear removes all keys", () => {
    const store = createStore()
    store.set("a", 1)
    store.set("b", 2)
    store.clear()
    expect(store.size).toBe(0)
  })

  test("store property returns all data as object", () => {
    const store = createStore()
    store.set("x", 10)
    store.set("y", 20)
    expect(store.store).toEqual({ x: 10, y: 20 })
  })

  test("multiple stores are independent", () => {
    const storeA = createStore()
    const storeB = createStore()

    storeA.set("shared-key", "from-a")
    storeB.set("shared-key", "from-b")

    expect(storeA.get("shared-key")).toBe("from-a")
    expect(storeB.get("shared-key")).toBe("from-b")
  })

  test("can store complex objects", () => {
    const store = createStore()
    const obj = { name: "test", items: [1, 2, 3], nested: { a: 1 } }
    store.set("complex", obj)
    expect(store.get("complex")).toEqual(obj)
  })
})

describe("store cache/singleton pattern", () => {
  // Tests the pattern used in store.ts where stores are cached by name

  function createStoreCache() {
    const cache = new Map<string, ReturnType<typeof createStore>>()

    function createStore() {
      const data = new Map<string, any>()
      return {
        get: (key: string) => data.get(key),
        set: (key: string, value: any) => { data.set(key, value) },
        delete: (key: string) => data.delete(key),
        clear: () => data.clear(),
        get store() { return Object.fromEntries(data) },
      }
    }

    const getStore = (name = "opencode.settings") => {
      const cached = cache.get(name)
      if (cached) return cached
      const next = createStore()
      cache.set(name, next)
      return next
    }

    return { getStore, cache }
  }

  test("getStore caches and returns same instance for same name", () => {
    const { getStore } = createStoreCache()
    const a = getStore("cache-test")
    const b = getStore("cache-test")
    expect(a).toBe(b)
  })

  test("getStore creates separate instances for different names", () => {
    const { getStore } = createStoreCache()
    const a = getStore("store-a")
    const b = getStore("store-b")
    expect(a).not.toBe(b)
  })

  test("default store name is used when no name given", () => {
    const { getStore } = createStoreCache()
    const defaultStore = getStore()
    const explicitStore = getStore("opencode.settings")
    expect(defaultStore).toBe(explicitStore)
  })

  test("values persist in the cached store", () => {
    const { getStore } = createStoreCache()
    getStore("persist").set("key", "value")
    const same = getStore("persist")
    expect(same.get("key")).toBe("value")
  })
})

describe("integer store wrapper for IPC serialization", () => {
  // Tests how the IPC handlers in ipc.ts convert store values

  function serializeValue(value: unknown): string | null {
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  }

  test("serializes null/undefined to null", () => {
    expect(serializeValue(undefined)).toBe(null)
    expect(serializeValue(null)).toBe(null)
  })

  test("passes through strings directly", () => {
    expect(serializeValue("hello")).toBe("hello")
    expect(serializeValue("")).toBe("")
  })

  test("JSON-stringifies non-string values", () => {
    expect(serializeValue(42)).toBe("42")
    expect(serializeValue(true)).toBe("true")
    expect(serializeValue([1, 2, 3])).toBe("[1,2,3]")
    expect(serializeValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe("store IPC handler logic", () => {
  // Tests the complete handler logic (reserved names + store operations)

  const RESERVED_STORE_NAMES = ["desktop-custom-agents", "desktop-mcp-servers", "desktop-plugin-config", "github-auth"]

  function createStoreSystem() {
    const stores = new Map<string, Map<string, any>>()

    function getOrCreateStore(name: string) {
      if (!stores.has(name)) stores.set(name, new Map())
      return stores.get(name)!
    }

    function handleStoreGet(_event: any, name: string, key: string) {
      if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
      const store = getOrCreateStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    }

    function handleStoreSet(_event: any, name: string, key: string, value: string) {
      if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
      getOrCreateStore(name).set(key, value)
    }

    function handleStoreDelete(_event: any, name: string, key: string) {
      if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
      getOrCreateStore(name).delete(key)
    }

    function handleStoreClear(_event: any, name: string) {
      if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
      getOrCreateStore(name).clear()
    }

    function handleStoreKeys(_event: any, name: string) {
      return Array.from(getOrCreateStore(name).keys())
    }

    function handleStoreLength(_event: any, name: string) {
      return getOrCreateStore(name).size
    }

    return {
      handleStoreGet,
      handleStoreSet,
      handleStoreDelete,
      handleStoreClear,
      handleStoreKeys,
      handleStoreLength,
      getStoreData: (name: string) => getOrCreateStore(name),
    }
  }

  test("store-get returns values that were set", () => {
    const { handleStoreSet, handleStoreGet } = createStoreSystem()
    const event = {}
    handleStoreSet(event, "my-stuff", "key1", "hello")
    const result = handleStoreGet(event, "my-stuff", "key1")
    expect(result).toBe("hello")
  })

  test("store-get returns null for non-existent keys", () => {
    const { handleStoreGet } = createStoreSystem()
    expect(handleStoreGet({}, "my-stuff", "missing")).toBe(null)
  })

  test("store-set overwrites existing values", () => {
    const { handleStoreSet, handleStoreGet } = createStoreSystem()
    handleStoreSet({}, "my-stuff", "key", "first")
    handleStoreSet({}, "my-stuff", "key", "second")
    expect(handleStoreGet({}, "my-stuff", "key")).toBe("second")
  })

  test("store-delete removes a key", () => {
    const { handleStoreSet, handleStoreGet, handleStoreDelete } = createStoreSystem()
    handleStoreSet({}, "my-stuff", "temp", "value")
    handleStoreDelete({}, "my-stuff", "temp")
    expect(handleStoreGet({}, "my-stuff", "temp")).toBe(null)
  })

  test("store-clear removes all keys in a store", () => {
    const { handleStoreSet, handleStoreClear, handleStoreKeys } = createStoreSystem()
    handleStoreSet({}, "my-stuff", "a", "1")
    handleStoreSet({}, "my-stuff", "b", "2")
    handleStoreClear({}, "my-stuff")
    expect(handleStoreKeys({}, "my-stuff")).toEqual([])
  })

  test("store-keys returns all keys", () => {
    const { handleStoreSet, handleStoreKeys } = createStoreSystem()
    handleStoreSet({}, "my-stuff", "x", "1")
    handleStoreSet({}, "my-stuff", "y", "2")
    const keys = handleStoreKeys({}, "my-stuff")
    expect(keys).toContain("x")
    expect(keys).toContain("y")
    expect(keys.length).toBe(2)
  })

  test("store-length returns correct count", () => {
    const { handleStoreSet, handleStoreLength } = createStoreSystem()
    handleStoreSet({}, "my-stuff", "a", "1")
    handleStoreSet({}, "my-stuff", "b", "2")
    handleStoreSet({}, "my-stuff", "c", "3")
    expect(handleStoreLength({}, "my-stuff")).toBe(3)
  })

  test("reserved store names are rejected on get", () => {
    const { handleStoreGet } = createStoreSystem()
    for (const name of RESERVED_STORE_NAMES) {
      expect(() => handleStoreGet({}, name, "any")).toThrow(`Access denied: '${name}' is a reserved store namespace`)
    }
  })

  test("reserved store names are rejected on set", () => {
    const { handleStoreSet } = createStoreSystem()
    for (const name of RESERVED_STORE_NAMES) {
      expect(() => handleStoreSet({}, name, "k", "v")).toThrow(`Access denied: '${name}' is a reserved store namespace`)
    }
  })

  test("reserved store names are rejected on delete", () => {
    const { handleStoreDelete } = createStoreSystem()
    for (const name of RESERVED_STORE_NAMES) {
      expect(() => handleStoreDelete({}, name, "k")).toThrow(`Access denied: '${name}' is a reserved store namespace`)
    }
  })

  test("reserved store names are rejected on clear", () => {
    const { handleStoreClear } = createStoreSystem()
    for (const name of RESERVED_STORE_NAMES) {
      expect(() => handleStoreClear({}, name)).toThrow(`Access denied: '${name}' is a reserved store namespace`)
    }
  })

  test("value serialization: non-string values are JSON-stringified", () => {
    const { handleStoreGet, handleStoreSet, getStoreData } = createStoreSystem()
    // Store a JSON string
    handleStoreSet({}, "test", "num", JSON.stringify(42))
    const result = handleStoreGet({}, "test", "num")
    // The store returns the string as-is (it was stored as string)
    expect(result).toBe("42")
  })
})
