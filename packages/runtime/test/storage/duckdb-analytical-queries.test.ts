import { describe, expect, test } from "bun:test"

import {
  VALKEY_CONSUMER_GROUPS_TABLE,
  VALKEY_HEARTBEATS_TABLE,
  STALE_HEARTBEATS_VIEW,
  CONSUMER_LAG_VIEW,
  COORDINATION_HEALTH_VIEW,
  PACKET_PROPAGATION_VELOCITY_VIEW,
  FRAMEWORK_FAILURE_FREQUENCY_VIEW,
  DHARMA_PR_CORRELATION_VIEW,
  CODEX_STALENESS_VIEW,
  AGENT_ROUTE_QUALITY_VIEW,
  ALL_TABLES,
  ALL_VIEWS,
  ALL_CTX_TABLES,
  RUNTIME_EVENT_VIEWS,
} from "../../src/storage/schema.duckdb"

// ── Individual table/view structure checks ─────────────────
// Template literals start with \n, so we use .trimStart() before checking prefix.

describe("VALKEY_CONSUMER_GROUPS_TABLE", () => {
  const ddl = VALKEY_CONSUMER_GROUPS_TABLE

  test("is a non-empty string", () => {
    expect(typeof ddl).toBe("string")
    expect(ddl.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE TABLE", () => {
    expect(ddl.trimStart().startsWith("CREATE OR REPLACE TABLE")).toBe(true)
  })

  test("contains known column", () => {
    expect(ddl).toContain("pending_count")
  })
})

describe("VALKEY_HEARTBEATS_TABLE", () => {
  const ddl = VALKEY_HEARTBEATS_TABLE

  test("is a non-empty string", () => {
    expect(typeof ddl).toBe("string")
    expect(ddl.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE TABLE", () => {
    expect(ddl.trimStart().startsWith("CREATE OR REPLACE TABLE")).toBe(true)
  })

  test("contains known column", () => {
    expect(ddl).toContain("agent_id")
  })
})

describe("STALE_HEARTBEATS_VIEW", () => {
  const sql = STALE_HEARTBEATS_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("stale_seconds")
  })
})

describe("CONSUMER_LAG_VIEW", () => {
  const sql = CONSUMER_LAG_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("pending_count")
  })
})

describe("COORDINATION_HEALTH_VIEW", () => {
  const sql = COORDINATION_HEALTH_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("total_agents")
  })
})

describe("PACKET_PROPAGATION_VELOCITY_VIEW", () => {
  const sql = PACKET_PROPAGATION_VELOCITY_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("packet_family")
  })
})

describe("FRAMEWORK_FAILURE_FREQUENCY_VIEW", () => {
  const sql = FRAMEWORK_FAILURE_FREQUENCY_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("failure_count")
  })
})

describe("DHARMA_PR_CORRELATION_VIEW", () => {
  const sql = DHARMA_PR_CORRELATION_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("dharma_signal")
  })
})

describe("CODEX_STALENESS_VIEW", () => {
  const sql = CODEX_STALENESS_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("days_since_touch")
  })
})

describe("AGENT_ROUTE_QUALITY_VIEW", () => {
  const sql = AGENT_ROUTE_QUALITY_VIEW

  test("is a non-empty string", () => {
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)
  })

  test("starts with CREATE OR REPLACE VIEW", () => {
    expect(sql.trimStart().startsWith("CREATE OR REPLACE VIEW")).toBe(true)
  })

  test("contains known column", () => {
    expect(sql).toContain("error_rate")
  })
})

// ── Export array membership checks ─────────────────────────

describe("ALL_TABLES", () => {
  test("includes VALKEY_CONSUMER_GROUPS_TABLE", () => {
    expect(ALL_TABLES).toContain(VALKEY_CONSUMER_GROUPS_TABLE)
  })

  test("includes VALKEY_HEARTBEATS_TABLE", () => {
    expect(ALL_TABLES).toContain(VALKEY_HEARTBEATS_TABLE)
  })
})

describe("RUNTIME_EVENT_VIEWS", () => {
  // coordination views
  test("includes STALE_HEARTBEATS_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(STALE_HEARTBEATS_VIEW)
  })

  test("includes CONSUMER_LAG_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(CONSUMER_LAG_VIEW)
  })

  test("includes COORDINATION_HEALTH_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(COORDINATION_HEALTH_VIEW)
  })

  // product views
  test("includes PACKET_PROPAGATION_VELOCITY_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(PACKET_PROPAGATION_VELOCITY_VIEW)
  })

  test("includes FRAMEWORK_FAILURE_FREQUENCY_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(FRAMEWORK_FAILURE_FREQUENCY_VIEW)
  })

  test("includes DHARMA_PR_CORRELATION_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(DHARMA_PR_CORRELATION_VIEW)
  })

  test("includes CODEX_STALENESS_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(CODEX_STALENESS_VIEW)
  })

  test("includes AGENT_ROUTE_QUALITY_VIEW", () => {
    expect(RUNTIME_EVENT_VIEWS).toContain(AGENT_ROUTE_QUALITY_VIEW)
  })
})

describe("ALL_VIEWS", () => {
  test("is still an array with expected items", () => {
    expect(Array.isArray(ALL_VIEWS)).toBe(true)
    expect(ALL_VIEWS.length).toBeGreaterThanOrEqual(2)
    // Existing views should still be present by content
    expect(ALL_VIEWS.some((v) => v.includes("_analytics_session_clustering"))).toBe(true)
    expect(ALL_VIEWS.some((v) => v.includes("_analytics_tool_usage"))).toBe(true)
  })
})

describe("ALL_CTX_TABLES", () => {
  test("is still an array with expected items", () => {
    expect(Array.isArray(ALL_CTX_TABLES)).toBe(true)
    expect(ALL_CTX_TABLES.length).toBeGreaterThanOrEqual(5)
    expect(ALL_CTX_TABLES.some((v) => v.includes("_ctx_file_events"))).toBe(true)
    expect(ALL_CTX_TABLES.some((v) => v.includes("_ctx_file_relevance"))).toBe(true)
    expect(ALL_CTX_TABLES.some((v) => v.includes("_ctx_file_cochange"))).toBe(true)
    expect(ALL_CTX_TABLES.some((v) => v.includes("_ctx_agent_heatmap"))).toBe(true)
    expect(ALL_CTX_TABLES.some((v) => v.includes("_ctx_error_files"))).toBe(true)
  })
})
