//! ANE legality — backend constraint validation modeled on Orion's 20
//! empirically discovered ANE restrictions.

use std::time::Instant;

use crate::backend::DType;
use crate::backend::routing::{
    BackendId, EvidenceDigest, OperationId, TensorId,
};
use crate::compiler::pass::PassIdentity;
use crate::compiler::scheduled::ScheduledRegion;

// ── Rule identity ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RuleIdentity {
    pub id: String,
    pub version: String,
    pub provenance: String,
    pub implementation_digest: EvidenceDigest,
    /// Evidence qualification state — prevents Orion's observed behavior
    /// from becoming an unquestioned Tribunus hardware invariant.
    pub evidence_state: RuleEvidenceState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleEvidenceState {
    ImportedUnverified,
    Reproduced,
    Contradicted,
    Superseded,
}

// ── Rule category ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleCategory {
    MilGraph,
    OperationLowering,
    TensorShapeDtype,
    IoSurfaceAllocation,
    InputOutputOrdering,
    WeightArtifact,
    CompilationResource,
    RuntimeNumericalHazard,
}

// ── Legality status ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegalityStatus {
    Legal,
    LegalAfterRewrite,
    Illegal,
    /// Region has not been qualified — rules have not been reproduced
    /// against this machine profile.
    Unqualified,
}

// ── Rule evaluation ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RuleEvaluation {
    pub rule: RuleIdentity,
    pub category: RuleCategory,
    pub satisfied: bool,
    pub description: String,
    pub affected_ops: Vec<OperationId>,
    pub affected_tensors: Vec<TensorId>,
}

// ── Legality violation ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AneLegalityViolation {
    pub rule: RuleIdentity,
    pub category: RuleCategory,
    pub operations: Vec<OperationId>,
    pub tensors: Vec<TensorId>,
    pub message: String,
    pub fatal: bool,
}

// ── Required rewrite ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RequiredRewrite {
    pub id: String,
    pub description: String,
    pub affected_operations: Vec<OperationId>,
    pub affected_tensors: Vec<TensorId>,
    pub output_contract: OutputContract,
    pub tolerance: f64,
    /// Versioned compiler pass identity — binds the rewrite to the exact
    /// implementation, not just a name.
    pub pass: PassIdentity,
    pub resolves_violation: RuleIdentity,
}

#[derive(Debug, Clone)]
pub struct OutputContract {
    pub element_count: u64,
    pub byte_size: u64,
    pub shape: Vec<u64>,
    pub dtype: DType,
}

// ── ANE legality receipt ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AneLegalityReceipt {
    pub rule_set: RuleSetIdentity,
    pub region_digest: EvidenceDigest,
    pub machine_profile_digest: EvidenceDigest,
    pub status: LegalityStatus,
    pub satisfied_rules: Vec<RuleEvaluation>,
    pub violations: Vec<AneLegalityViolation>,
    pub required_rewrites: Vec<RequiredRewrite>,
    pub receipt_digest: EvidenceDigest,
    pub evaluation_ns: u64,
}

#[derive(Debug, Clone)]
pub struct RuleSetIdentity {
    pub name: String,
    pub version: String,
    pub rule_count: u32,
    pub provenance: String,
}

// ── ANE legality evaluator ────────────────────────────────────────────────

pub struct AneLegality {
    rules: Vec<Box<dyn AneRule>>,
    machine_profile_digest: EvidenceDigest,
    rule_set: RuleSetIdentity,
}

impl AneLegality {
    pub fn new(machine_profile_digest: EvidenceDigest) -> Self {
        Self {
            rules: Vec::new(),
            machine_profile_digest,
            rule_set: RuleSetIdentity {
                name: "ane-legality-v1".into(),
                version: "1.0.0".into(),
                rule_count: 0,
                provenance: "Orion pass_ane_validate.c + Apple MIL spec".into(),
            },
        }
    }

    pub fn add_rule(&mut self, rule: Box<dyn AneRule>) {
        self.rules.push(rule);
        self.rule_set.rule_count = self.rules.len() as u32;
    }

    pub fn evaluate_region(&self, region: &ScheduledRegion) -> AneLegalityReceipt {
        let start = Instant::now();
        let mut satisfied = Vec::new();
        let mut violations = Vec::new();
        let mut required_rewrites = Vec::new();

        for rule in &self.rules {
            let eval = rule.evaluate(region);
            if !eval.satisfied {
                violations.push(AneLegalityViolation {
                    rule: eval.rule.clone(), category: eval.category,
                    operations: eval.affected_ops.clone(),
                    tensors: eval.affected_tensors.clone(),
                    message: eval.description.clone(), fatal: rule.is_fatal(),
                });
                if let Some(rw) = rule.suggested_rewrite(region, &eval) {
                    required_rewrites.push(rw);
                }
            }
            satisfied.push(eval);
        }

        let status = if self.rules.is_empty() {
            LegalityStatus::Unqualified
        } else if violations.iter().any(|v| v.fatal) {
            LegalityStatus::Illegal
        } else if !violations.is_empty() {
            LegalityStatus::LegalAfterRewrite
        } else {
            LegalityStatus::Legal
        };

        let evaluation_ns = start.elapsed().as_nanos() as u64;
        let region_digest = region_digest_from_region(region);
        let receipt_digest = compute_receipt_digest(&region_digest, &status, &violations);

        AneLegalityReceipt {
            rule_set: self.rule_set.clone(),
            region_digest,
            machine_profile_digest: self.machine_profile_digest.clone(),
            status,
            satisfied_rules: satisfied,
            violations,
            required_rewrites,
            receipt_digest,
            evaluation_ns,
        }
    }
}

// ── ANE rule trait ────────────────────────────────────────────────────────

pub trait AneRule {
    fn identity(&self) -> RuleIdentity;
    fn category(&self) -> RuleCategory;
    fn evaluate(&self, region: &ScheduledRegion) -> RuleEvaluation;
    fn is_fatal(&self) -> bool;
    fn suggested_rewrite(&self, _region: &ScheduledRegion, _violation: &RuleEvaluation) -> Option<RequiredRewrite> { None }
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn region_digest_from_region(region: &ScheduledRegion) -> EvidenceDigest {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(format!("{}", region.region_id.0).as_bytes());
    h.update(format!("{}", region.operations.len()).as_bytes());
    EvidenceDigest(format!("{:x}", h.finalize()))
}

fn compute_receipt_digest(
    region_digest: &EvidenceDigest, status: &LegalityStatus,
    violations: &[AneLegalityViolation],
) -> EvidenceDigest {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(region_digest.0.as_bytes());
    h.update(format!("{:?}", status).as_bytes());
    for v in violations {
        h.update(v.rule.id.as_bytes());
        h.update(v.message.as_bytes());
    }
    EvidenceDigest(format!("{:x}", h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::scheduled::{RegionId, ScheduledRegion};

    fn empty_region() -> ScheduledRegion {
        ScheduledRegion {
            region_id: RegionId(1), name: "test".into(), operations: vec![],
            selected_backend: BackendId(4), physical_tensors: vec![],
            inputs: vec![], outputs: vec![], dependencies: vec![],
            fusions: vec![], state_effects: vec![], temp_memory_bytes: 0,
            is_fence: false,
        }
    }

    #[test]
    fn empty_rule_set_is_unqualified() {
        let legality = AneLegality::new(EvidenceDigest("test".into()));
        let receipt = legality.evaluate_region(&empty_region());
        assert_eq!(receipt.status, LegalityStatus::Unqualified);
        assert!(!receipt.receipt_digest.0.is_empty());
    }
}
