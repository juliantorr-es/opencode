# Tier 1 Defect Clustering — DA-0001-193461

Total non-pass Tier 1 rows: 13

## Cluster summary

| Cluster | Count | Description |
|---------|-------|-------------|
| A: coreml-mil-shape                 |     6 | Core ML MIL shape-contract failure (incompatible broadcast dims) |
| B: coreml-predict-runtime           |     2 | Core ML predict returns error -20 (compiles but fails at predict) |
| C: mlx-broadcast-reject             |     2 | MLX broadcasting rejects shape pair |
| D1: count-mismatch                  |     2 | Backend/reference output element count differs |
| D2: numerical-divergence            |     1 | Real numerical mismatch (same lengths, different values) |

## Triage table

| backend | family | shape | status | terminal_phase | max_abs_err | cos_sim | exec_kind | exec_ops | cluster | next_action |
|---------|--------|-------|--------|----------------|-------------|---------|-----------|----------|---------|-------------|
| coreml     | add_standalone       | small  | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | add_standalone       | A: coreml-mil-shape       | fix graph catalog builder shapes |
| coreml     | add_standalone       | medium | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | add_standalone       | A: coreml-mil-shape       | fix graph catalog builder shapes |
| coreml     | mul_standalone       | small  | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | mul_standalone       | A: coreml-mil-shape       | fix graph catalog builder shapes |
| coreml     | mul_standalone       | medium | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | mul_standalone       | A: coreml-mil-shape       | fix graph catalog builder shapes |
| coreml     | sigmoid_standalone   | small  | prediction_error       | predict         |         0.0 |  0.0000 | coreml_predict         | sigmoid_standalone   | B: coreml-predict-runtime | investigate Core ML runtime -20 (os version?) |
| coreml     | sigmoid_standalone   | medium | prediction_error       | predict         |         0.0 |  0.0000 | coreml_predict         | sigmoid_standalone   | B: coreml-predict-runtime | investigate Core ML runtime -20 (os version?) |
| coreml     | silu_standalone      | small  | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | silu_standalone      | A: coreml-mil-shape       | fix graph catalog builder shapes |
| coreml     | silu_standalone      | medium | compile_error          | mil_build       |         0.0 |  0.0000 | coreml_predict         | silu_standalone      | A: coreml-mil-shape       | fix graph catalog builder shapes |
| mlx        | add_standalone       | medium | prediction_error       |                 |         0.0 |  0.0000 | mlx_eval               | add_standalone       | C: mlx-broadcast-reject   | fix graph catalog shapes or adapter reshape |
| mlx        | mul_standalone       | small  | numerical_divergence   |                 |           ∞ |  0.0000 | mlx_eval               | mul_standalone       | D1: count-mismatch        | unify broadcasting between reference adapter and backends |
| mlx        | mul_standalone       | medium | prediction_error       |                 |         0.0 |  0.0000 | mlx_eval               | mul_standalone       | C: mlx-broadcast-reject   | fix graph catalog shapes or adapter reshape |
| accelerate | add_standalone       | small  | numerical_divergence   | conformance     |           ∞ |  0.0000 | DomainCpuAdapter       | vDSP: add:vDSP_vadd  | D1: count-mismatch        | unify broadcasting between reference adapter and backends |
| accelerate | mul_standalone       | medium | numerical_divergence   | conformance     |      1.4119 |  0.7211 | DomainCpuAdapter       | vDSP: mul:vDSP_vmul  | D2: numerical-divergence  | investigate weight seed / vDSP precision |

## Recommended next gate

**FIX-COREML-STANDALONE-SHAPES** — Fix the graph catalog builders for
`add_standalone`, `mul_standalone`, and `silu_standalone` to produce
broadcast-compatible MIL shapes.

Rationale:
- Highest leverage: fixes cluster A (6 rows) and may cascade to fix
  cluster C (2 rows) = up to 8 rows recovered
- Lowest risk: only affects Tier 1 families that currently fail
- Root cause is well-understood (MIL shape-contract violation) and
  manifests identically across 6 receipts
