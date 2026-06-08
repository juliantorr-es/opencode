# OpenCode to OMP Tool Mapping

This documents the actual behavioral analysis of all 52 OpenCode custom tools and their OMP equivalents (or lack thereof).

## Direct equivalents (no behavioral gap)

| OpenCode Tool | OMP Equivalent | Analysis |
|---|---|---|
| `smart_grep` | `search` | Both regex search with gitignore respect. `smart_grep` adds `context_lines` and `word_boundary` — minor presentation differences. |
| `smart_find` | `find` | Both file discovery with gitignore, depth, limit. Feature-compatible. |
| `smart_write` | `write` | Both create/overwrite files with parent dir creation. `smart_write` adds an `overwrite: false` guard and git diff output. |
| `smart_edit` | `edit` | Both perform exact text replacement with validation. `smart_edit` adds explicit occurrence handling and diff output. |
| `web_search` | `web_search` | Identical. |
| `smart_bash` | `bash` | Both run shell commands. |
| `browser` | `browser` | Identical. |
| `json_query` | `eval` (Python/JS) | `eval` is strictly more powerful. |
| `replace_symbol` | `ast_edit` + `lsp rename` | AST-level replacement in both. |
| `diagram` | `render_mermaid` | Identical. |
| `record` | `retain` / `recall` | `record` persists to JSONL files; `retain`/`recall` persists to memory backend. Same purpose. |
| `session_journal` | OMP session tracking | Built-in. |

## Significant behavioral gaps (OMP is missing capability)

| OpenCode Tool | What it does that OMP can't | Severity |
|---|---|---|
| **`read_source`** | Structural file reader with tree-sitter AST. Extracts imports, exports, top-level symbols. **Focus mode**: given a symbol name, extracts just that function/class/type with its import block using tree-sitter parsing. Falls back to regex+brace counting. Returns structured JSON with imports/exports/symbols. OMP's `read` shows raw text with line ranges but has no structural extraction or symbol focus. | **HIGH** |
| **`smart_git`** | Structured git wrapper. Parses `status` into JSON with staged/unstaged/untracked counts. Parses `log` into commit objects. Generates diffs styled with delta/difftastic (AST-aware diff tools). Blocks destructive operations (force push, hard reset, branch delete). OMP's `bash` runs raw git with no structure or safety guards. | MEDIUM |
| **`smart_bun`** | Structured bun wrapper. Parses `typecheck` errors into structured JSON with file/line/message. Parses `test` output into pass/fail/skip counts with timing. Auto-detects package.json scripts for test/typecheck. OMP's `bash` runs raw bun with no parsing. | MEDIUM |
| **`fragment`** | Multi-lane file coordination. Lanes declare edit regions with anchor points. Consolidator assembles non-conflicting fragments. Detects collisions. OpenCode-specific lane model — OMP handles concurrent edits differently. | LOW |
| **`verify`** | File existence checker + handoff JSON claim validator + preflight dirty-state checker + import reference validator. `action: "files"` checks files exist on disk. `action: "imports"` checks import references resolve. `action: "preflight"` checks for file locks. | LOW |

## Already filled by custom tools

| Gap | Custom Tool | Location |
|---|---|---|
| `smart_sd` (literal text replacement) | `text_replace` | `.omp/tools/text_replace.ts` |
| `smart_batch` (atomic multi-file edits) | `batch_edit` | `.omp/tools/batch_edit.ts` |
| Research packet generation | `generate_research_context_packets` | `.omp/tools/generate_research_context_packets.ts` |
| Research-linked ADR updates | `update_adr` | `.omp/tools/update_adr.ts` |

## OpenCode-specific orchestration (not applicable to OMP)

These tools are tightly coupled to OpenCode's lane/artifact/session model and have no equivalent OMP need: `feedback`, `gate`, `discover`, `validator`, `doctor`, `ping`, `leaf_handoff`, `task_board`, `roadmap`, `plan`, `dashboard`, `smart_session`, `power_tools`, `deep_analyze`, `system_test`, `codebase_index`, `local_llm`, `config_sync`, `config`, `persistence`, `janitor`, `file_lock`, `semantic_search`, `analytics`, `db_query`, `db`, `rig_schema_validate`.

The GitHub tools are intentionally omitted from the native OMP port: `github_full`, `github`.
