// ═══════════════════════════════════════════════════════════════
// SIDECAR-STARTUP-TRUTH — Regression Proof Tests
//
// Each test named after a failure class from the taxonomy.
// Pure-function proofs that the classification and trace
// logic works correctly.
// ═══════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test"
import {
  SIDECAR_FAILURE_CODES,
  classifyError,
  redactSecrets,
} from "../src/main/sidecar-startup-trace"

// ── Failure Classification ────────────────────────────────────

describe("Sidecar failure classification", () => {
  test("regression_sidecar_port_conflict_produces_typed_failure", () => {
    expect(classifyError(new Error("EADDRINUSE: address already in use :::4096"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.PORT_CONFLICT)
    expect(classifyError(new Error("Port 4096 is already in use"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.PORT_CONFLICT)
    expect(classifyError(new Error("listen EACCES: permission denied"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.PERMISSION_DENIED)
  })

  test("regression_sidecar_config_parse_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("Config parse error: invalid syntax at line 5"), "config.load"))
      .toBe(SIDECAR_FAILURE_CODES.CONFIG_PARSE_FAILED)
    expect(classifyError(new Error("malformed configuration"), "config.load"))
      .toBe(SIDECAR_FAILURE_CODES.CONFIG_PARSE_FAILED)
  })

  test("regression_sidecar_db_init_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("PGlite initialization failed: no such file"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.DB_INIT_FAILED)
    expect(classifyError(new Error("Database connection failed"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.DB_INIT_FAILED)
  })

  test("regression_sidecar_db_migration_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("Migration failed: column already exists"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.DB_MIGRATION_FAILED)
    expect(classifyError(new Error("migrate error: duplicate key"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.DB_MIGRATION_FAILED)
  })

  test("regression_sidecar_native_module_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("Native module load failed: better-sqlite3"), "server-import"))
      .toBe(SIDECAR_FAILURE_CODES.NATIVE_MODULE_FAILED)
    expect(classifyError(new Error("addon binding error"), "server-import"))
      .toBe(SIDECAR_FAILURE_CODES.NATIVE_MODULE_FAILED)
  })

  test("regression_sidecar_plugin_init_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("Plugin init error: missing dependency"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.PLUGIN_INIT_FAILED)
    expect(classifyError(new Error("plugin load failed"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.PLUGIN_INIT_FAILED)
  })

  test("regression_sidecar_mcp_init_failed_produces_typed_failure", () => {
    expect(classifyError(new Error("MCP server start error: connection refused"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.MCP_INIT_FAILED)
    expect(classifyError(new Error("mcp connect failed: timeout"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.MCP_INIT_FAILED)
  })

  test("regression_sidecar_permission_denied_produces_typed_failure", () => {
    expect(classifyError(new Error("EACCES: permission denied, open '/root/config.json'"), "config.load"))
      .toBe(SIDECAR_FAILURE_CODES.PERMISSION_DENIED)
  })

  test("regression_sidecar_path_missing_produces_typed_failure", () => {
    expect(classifyError(new Error("ENOENT: no such file or directory"), "server-import"))
      .toBe(SIDECAR_FAILURE_CODES.PATH_MISSING)
  })

  test("regression_sidecar_unknown_fatal_for_unclassified_errors", () => {
    expect(classifyError(new Error("Something completely unexpected happened"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.UNKNOWN_FATAL)
    expect(classifyError(new Error("undefined is not a function"), "server-listen"))
      .toBe(SIDECAR_FAILURE_CODES.UNKNOWN_FATAL)
  })
})

// ── Secret Redaction ──────────────────────────────────────────

describe("Sidecar secret redaction", () => {
  test("regression_startup_trace_redacts_authorization_headers", () => {
    const input = 'authorization: Bearer sk-abc123def456'
    const result = redactSecrets(input)
    expect(result).not.toContain("sk-abc123def456")
    expect(result).toContain("***")
  })

  test("regression_startup_trace_redacts_api_keys", () => {
    const input = 'api_key=sk-proj-12345'
    const result = redactSecrets(input)
    expect(result).not.toContain("sk-proj-12345")
    expect(result).toContain("***")
  })

  test("regression_startup_trace_redacts_bearer_tokens", () => {
    const input = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    const result = redactSecrets(input)
    expect(result).not.toContain("eyJhbGci")
    expect(result).toContain("Bearer ***")
  })

  test("regression_startup_trace_redacts_private_keys", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
    const result = redactSecrets(input)
    expect(result).not.toContain("MIIEpA")
    expect(result).toContain("PRIVATE KEY")
  })

  test("regression_startup_trace_preserves_non_secret_text", () => {
    const input = "Server listening on port 4096"
    const result = redactSecrets(input)
    expect(result).toBe(input)
  })

  test("regression_startup_trace_redacts_password_fields", () => {
    const input = 'password=mysecretpassword123'
    const result = redactSecrets(input)
    expect(result).not.toContain("mysecretpassword123")
    expect(result).toContain("***")
  })
})

// ── Failure Code Completeness ─────────────────────────────────

describe("Sidecar failure taxonomy completeness", () => {
  test("all_required_failure_codes_exist", () => {
    const required = [
      "sidecar.port_conflict",
      "sidecar.config_parse_failed",
      "sidecar.db_init_failed",
      "sidecar.db_migration_failed",
      "sidecar.duckdb_init_failed",
      "sidecar.native_module_failed",
      "sidecar.plugin_init_failed",
      "sidecar.mcp_init_failed",
      "sidecar.permission_denied",
      "sidecar.path_missing",
      "sidecar.env_invalid",
      "sidecar.process_exited_before_ready",
      "sidecar.timeout_before_ready",
      "sidecar.unknown_fatal",
    ]
    for (const code of required) {
      expect(Object.values(SIDECAR_FAILURE_CODES)).toContain(code)
    }
  })

  test("all_failure_codes_are_unique", () => {
    const codes = Object.values(SIDECAR_FAILURE_CODES)
    expect(new Set(codes).size).toBe(codes.length)
  })

  test("every_failure_code_starts_with_sidecar_prefix", () => {
    for (const code of Object.values(SIDECAR_FAILURE_CODES)) {
      expect(code.startsWith("sidecar.")).toBe(true)
    }
  })
})
