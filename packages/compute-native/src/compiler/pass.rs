//! Compiler pass framework — versioned transformation passes with receipts.
//!
//! Every pass consumes one sealed IR identity and produces another, along
//! with a [`TransformReceipt`]. This makes every compiler decision
//! reproducible and scientifically attributable.

use crate::backend::routing::EvidenceDigest;

// ── Pass identity ──────────────────────────────────────────────────────────

/// Identifies a specific version of a compiler pass.
#[derive(Debug, Clone)]
pub struct PassIdentity {
    /// Human-readable pass name (e.g. "shape:canonicalize").
    pub name: String,
    /// Semantic version of this pass implementation.
    pub version: String,
    /// Content-addressed digest of the pass's logic.
    pub implementation_digest: EvidenceDigest,
}

// ── Pass receipt ───────────────────────────────────────────────────────────

/// Complete receipt for a single compiler pass invocation.
#[derive(Debug, Clone)]
pub struct TransformReceipt {
    /// Identity of the pass that was applied.
    pub pass: PassIdentity,
    /// Digest of the IR before this pass.
    pub input_digest: EvidenceDigest,
    /// Digest of the IR after this pass.
    pub output_digest: EvidenceDigest,
    /// Number of rewrites applied.
    pub rewrites_applied: u64,
    /// Number of rewrite candidates that were rejected.
    pub rewrites_rejected: u64,
    /// Human-readable descriptions of what was changed.
    pub rewrite_descriptions: Vec<String>,
    /// Whether a fixpoint was reached.
    pub reached_fixpoint: bool,
    /// Wall-clock duration of this pass (nanoseconds).
    pub duration_ns: u64,
    /// Whether this pass claims semantic equivalence.
    pub equivalence_claimed: bool,
    /// Evidence for claimed equivalence.
    pub equivalence_evidence: Option<EvidenceDigest>,
}

// ── Pass trait ─────────────────────────────────────────────────────────────

/// A single compiler transformation pass.
///
/// Passes are applied in a fixed pipeline order. Each pass consumes one
/// sealed IR identity and produces another, along with a receipt.
pub trait TransformPass<IR: Clone> {
    /// Return the identity of this pass.
    fn identity(&self) -> &PassIdentity;

    /// Precondition check — does this pass apply to the given IR?
    fn applies_to(&self, ir: &IR) -> bool;

    /// Apply this pass to the IR, returning the transformed IR and a receipt.
    fn apply(&self, ir: &IR, input_digest: EvidenceDigest) -> (IR, TransformReceipt);
}

// ── Pipeline ───────────────────────────────────────────────────────────────

/// A fixed-order pipeline of transformation passes.
///
/// Applies each pass in sequence until no pass reports changes (fixpoint)
/// or the maximum iteration count is reached.
pub struct TransformPipeline<IR: Clone> {
    passes: Vec<Box<dyn TransformPass<IR>>>,
    max_iterations: u32,
}

impl<IR: Clone> TransformPipeline<IR> {
    /// Create a new pipeline with the given passes.
    pub fn new(passes: Vec<Box<dyn TransformPass<IR>>>) -> Self {
        Self {
            passes,
            max_iterations: 20,
        }
    }

    /// Set the maximum number of fixpoint iterations.
    pub fn with_max_iterations(mut self, max: u32) -> Self {
        self.max_iterations = max;
        self
    }

    /// Run the pipeline on an IR, returning the final IR and all receipts.
    pub fn run(
        &self,
        initial: &IR,
        initial_digest: EvidenceDigest,
    ) -> (IR, Vec<TransformReceipt>) {
        let mut receipts = Vec::new();
        let mut current = initial.clone();
        let mut current_digest = initial_digest;

        for iteration in 0..self.max_iterations {
            let mut any_changed = false;

            for pass in &self.passes {
                if !pass.applies_to(&current) {
                    continue;
                }

                let start = std::time::Instant::now();
                let (next, receipt) = pass.apply(&current, current_digest.clone());
                let duration_ns = start.elapsed().as_nanos() as u64;

                let receipt = TransformReceipt {
                    duration_ns,
                    ..receipt
                };

                current = next;
                current_digest = receipt.output_digest.clone();

                if receipt.rewrites_applied > 0 {
                    any_changed = true;
                }
                receipts.push(receipt);
            }

            if !any_changed {
                if let Some(last) = receipts.last_mut() {
                    last.reached_fixpoint = true;
                }
                break;
            }
        }

        (current, receipts)
    }
}

// ── No-op pass (for testing) ───────────────────────────────────────────────

/// A pass that performs no transformations.
pub struct NoopPass {
    identity: PassIdentity,
}

impl NoopPass {
    pub fn new() -> Self {
        Self {
            identity: PassIdentity {
                name: "noop".into(),
                version: "1.0.0".into(),
                implementation_digest: EvidenceDigest(String::new()),
            },
        }
    }
}

impl<IR: Clone> TransformPass<IR> for NoopPass {
    fn identity(&self) -> &PassIdentity {
        &self.identity
    }

    fn applies_to(&self, _ir: &IR) -> bool {
        true
    }

    fn apply(&self, ir: &IR, input_digest: EvidenceDigest) -> (IR, TransformReceipt) {
        let receipt = TransformReceipt {
            pass: self.identity.clone(),
            input_digest: input_digest.clone(),
            output_digest: input_digest,
            rewrites_applied: 0,
            rewrites_rejected: 0,
            rewrite_descriptions: vec![],
            reached_fixpoint: true,
            duration_ns: 0,
            equivalence_claimed: true,
            equivalence_evidence: None,
        };
        (ir.clone(), receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CounterPass {
        identity: PassIdentity,
    }

    impl CounterPass {
        fn new() -> Self {
            Self {
                identity: PassIdentity {
                    name: "counter".into(),
                    version: "1.0.0".into(),
                    implementation_digest: EvidenceDigest(String::new()),
                },
            }
        }
    }

    impl TransformPass<u32> for CounterPass {
        fn identity(&self) -> &PassIdentity {
            &self.identity
        }

        fn applies_to(&self, _ir: &u32) -> bool {
            true
        }

        fn apply(&self, ir: &u32, input_digest: EvidenceDigest) -> (u32, TransformReceipt) {
            let output = ir + 1;
            let receipt = TransformReceipt {
                pass: self.identity.clone(),
                input_digest: input_digest.clone(),
                output_digest: EvidenceDigest(format!("counter_{}", output)),
                rewrites_applied: 1,
                rewrites_rejected: 0,
                rewrite_descriptions: vec![format!("incremented to {}", output)],
                reached_fixpoint: false,
                duration_ns: 0,
                equivalence_claimed: false,
                equivalence_evidence: None,
            };
            (output, receipt)
        }
    }

    #[test]
    fn pipeline_runs_passes() {
        let passes: Vec<Box<dyn TransformPass<u32>>> = vec![
            Box::new(CounterPass::new()),
            Box::new(CounterPass::new()),
            Box::new(CounterPass::new()),
        ];
        let pipeline = TransformPipeline::new(passes).with_max_iterations(1);

        let (result, receipts) = pipeline.run(&0, EvidenceDigest("init".into()));
        assert_eq!(result, 3);
        assert_eq!(receipts.len(), 3);
        for r in &receipts {
            assert_eq!(r.rewrites_applied, 1);
        }
    }

    #[test]
    fn noop_pass_does_nothing() {
        let pass = NoopPass::new();
        let input = 42u32;
        let (output, receipt) = pass.apply(&input, EvidenceDigest("before".into()));
        assert_eq!(output, input);
        assert_eq!(receipt.rewrites_applied, 0);
    }
}
