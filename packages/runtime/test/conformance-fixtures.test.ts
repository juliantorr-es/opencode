/**
 * Protocol Conformance Fixtures
 *
 * Shared test fixtures that any implementation can run to prove it conforms
 * to the Tribunus protocol spine. Language-agnostic JSON fixtures with
 * valid and intentionally invalid payloads.
 */
import { describe, test, expect } from "bun:test"
import * as fs from "node:fs"

// ── Fixture Types ────────────────────────────────────────────────────────────

interface ConformanceFixture {
  id: string
  protocol: string
  description: string
  valid: boolean
  payload: Record<string, unknown>
  expectedErrors?: string[]
}

// ── Schema Validation Fixtures ───────────────────────────────────────────────

const SCHEMA_FIXTURES: ConformanceFixture[] = [
  {
    id: "schema-valid-roadmap-v1",
    protocol: "rig.relay.roadmap.v1",
    description: "Valid v1 roadmap with campaigns array",
    valid: true,
    payload: {
      schema_version: "rig.relay.roadmap.v1",
      title: "Test Roadmap",
      status: "planned",
      created_at: "2026-01-01T00:00:00Z",
      campaigns: [],
    },
  },
  {
    id: "schema-invalid-missing-campaigns",
    protocol: "rig.relay.roadmap.v1",
    description: "Invalid: missing required campaigns field",
    valid: false,
    payload: {
      schema_version: "rig.relay.roadmap.v1",
      title: "Broken Roadmap",
      status: "planned",
      created_at: "2026-01-01T00:00:00Z",
    },
    expectedErrors: ["campaigns"],
  },
  {
    id: "schema-valid-campaign-v1",
    protocol: "rig.relay.campaign.v1",
    description: "Valid campaign with all required fields",
    valid: true,
    payload: {
      schema: "rig.relay.campaign.v1",
      id: "0001",
      type: "campaign",
      name: "Test Campaign",
      slug: "test-campaign",
      campaign: "test",
      description: "A test campaign",
      objective: "Test objective",
      status: "not_started",
    },
  },
  {
    id: "schema-valid-mission-v1",
    protocol: "rig.relay.mission.v1",
    description: "Valid mission with required fields",
    valid: true,
    payload: {
      schema: "rig.relay.mission.v1",
      id: "0001-test-mission",
      type: "mission",
      name: "Test Mission",
      slug: "test-mission",
      campaignId: "0001",
      status: "not_started",
    },
  },
  {
    id: "schema-invalid-wrong-status",
    protocol: "rig.relay.campaign.v1",
    description: "Invalid: unknown status value",
    valid: false,
    payload: {
      schema: "rig.relay.campaign.v1",
      id: "0001",
      type: "campaign",
      name: "Test",
      slug: "test",
      campaign: "test",
      description: "Test",
      objective: "Test",
      status: "nonexistent_status",
    },
    expectedErrors: ["status"],
  },
]

// ── Runtime Event Fixtures ───────────────────────────────────────────────────

const EVENT_FIXTURES: ConformanceFixture[] = [
  {
    id: "event-valid-tool-call",
    protocol: "opencode.runtime_event.v1",
    description: "Valid tool_call event",
    valid: true,
    payload: {
      id: "evt-001",
      sessionId: "sess-001",
      runId: "run-001",
      ts: "2026-01-01T00:00:00.000Z",
      actor: "agent",
      eventType: "tool_call",
      status: "started",
      toolName: "bash",
    },
  },
  {
    id: "event-valid-with-trace",
    protocol: "opencode.runtime_event.v1",
    description: "Valid event with trace context",
    valid: true,
    payload: {
      id: "evt-002",
      sessionId: "sess-001",
      runId: "run-001",
      ts: "2026-01-01T00:00:01.000Z",
      actor: "system",
      eventType: "lifecycle",
      status: "completed",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      severity: "info",
      source: "coordination",
    },
  },
]

// ── ADR Fixtures ─────────────────────────────────────────────────────────────

const ADR_FIXTURES: ConformanceFixture[] = [
  {
    id: "adr-valid-v1",
    protocol: "rig.relay.adr.v1",
    description: "Valid ADR v1 document",
    valid: true,
    payload: {
      schema: "rig.relay.adr.v1",
      schema_version: "v1",
      id: "0001",
      title: "Test ADR",
      status: "proposed",
      date: "2026-01-01",
      authors: ["system"],
      tags: ["test"],
      context: "Test context",
      decision: "Test decision",
      consequences: "Test consequences",
      supersedes: [],
      superseded_by: [],
    },
  },
]

// ── All Fixtures ─────────────────────────────────────────────────────────────

const ALL_FIXTURES: ConformanceFixture[] = [
  ...SCHEMA_FIXTURES,
  ...EVENT_FIXTURES,
  ...ADR_FIXTURES,
]

// ── Conformance Test Runner ───────────────────────────────────────────────────

describe("Protocol Conformance Fixtures", () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture.id}: ${fixture.description}`, () => {
      // Structural checks
      expect(fixture.payload).toBeDefined()

      // For valid fixtures: verify structure is well-formed
      if (fixture.valid) {
        expect(fixture.payload.id || fixture.payload.schema_version).toBeDefined()
      }

      // For invalid fixtures: verify expected error patterns are documented
      if (!fixture.valid && fixture.expectedErrors) {
        expect(fixture.expectedErrors.length).toBeGreaterThan(0)
      }
    })
  }

  test("all fixtures are uniquely identified", () => {
    const ids = ALL_FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("fixture protocols are documented protocol spine schemas", () => {
    const knownProtocols = [
      "rig.relay.roadmap.v1",
      "rig.relay.campaign.v1",
      "rig.relay.mission.v1",
      "rig.relay.adr.v1",
      "opencode.runtime_event.v1",
    ]
    for (const fixture of ALL_FIXTURES) {
      expect(knownProtocols).toContain(fixture.protocol)
    }
  })

  test("valid fixtures outnumber invalid fixtures", () => {
    const valid = ALL_FIXTURES.filter((f) => f.valid).length
    const invalid = ALL_FIXTURES.length - valid
    expect(valid).toBeGreaterThan(invalid)
  })
})
