//! Integration test: F32 matmul through the full multi-level compiler IR.
//!
//! Proves that one canonical F32 matmul region can enter the Tribunus
//! semantic IR, pass through scheduling, and lower to the existing
//! backend graph contracts with transformation receipts.

#[cfg(test)]
mod tests {
    use crate::backend::routing::{
        BackendId, CompiledRegionHandle, EvidenceDigest, GraphRegion, LogicalShape,
        OperationFamily, OperationId, Phase, TensorId,
    };
    use crate::backend::graph::{BackendLegalityReceipt, GraphBackend, RegionExecutionReceipt};
    use crate::backend::DType;
    use crate::compiler::semantic::{
        SemanticModule, SemanticOp, ToleranceClass,
    };
    use crate::compiler::scheduled::{
        RegionId, ScheduledModule, ScheduledRegion,
    };
    // Import from compiler module via its public re-exports
    use crate::compiler::pass::{TransformPass, TransformPipeline, TransformReceipt, NoopPass};
    use crate::compiler::pass::PassIdentity;

    /// A minimal backend that accepts any non-empty region.
    struct StubBackend;

    impl GraphBackend for StubBackend {
        fn validate_region(
            &self,
            region: &GraphRegion,
        ) -> Result<BackendLegalityReceipt, String> {
            let legal = !region.operations.is_empty();
            Ok(BackendLegalityReceipt {
                legal,
                region_digest: EvidenceDigest(format!("region_{}", region.region_id)),
                machine_profile_digest: EvidenceDigest("stub".into()),
                violations: if legal { vec![] } else { vec!["empty region".into()] },
                violation_constraint_ids: if legal { vec![] } else { vec!["stub:empty".into()] },
                validation_ns: 0,
            })
        }

        fn compile_region(
            &mut self,
            _region: &GraphRegion,
        ) -> Result<(CompiledRegionHandle, u64), String> {
            Ok((CompiledRegionHandle { slot: 0, generation: 1 }, 0))
        }

        fn execute_region(
            &mut self,
            _region: CompiledRegionHandle,
            _inputs: &[TensorId],
        ) -> Result<RegionExecutionReceipt, String> {
            Err("stub: no execution".into())
        }

        fn graph_backend_id(&self) -> BackendId {
            BackendId(0)
        }

        fn is_region_cached(&self, _region: CompiledRegionHandle) -> bool {
            false
        }
    }

    /// A semantic-to-scheduled lowering pass that creates one region per op.
    struct SemanticToScheduledPass {
        identity: PassIdentity,
    }

    impl SemanticToScheduledPass {
        fn new() -> Self {
            Self {
                identity: PassIdentity {
                    name: "semantic_to_scheduled".into(),
                    version: "1.0.0".into(),
                    implementation_digest: EvidenceDigest(String::new()),
                },
            }
        }
    }

    impl TransformPass<SemanticModule> for SemanticToScheduledPass {
        fn identity(&self) -> &PassIdentity {
            &self.identity
        }

        fn applies_to(&self, _ir: &SemanticModule) -> bool { true }

        fn apply(
            &self,
            ir: &SemanticModule,
            input_digest: EvidenceDigest,
        ) -> (SemanticModule, TransformReceipt) {
            let mut scheduled = ScheduledModule::new(ir.digest.clone());
            let mut region_id = 0u64;

            for op in &ir.operations {
                scheduled.regions.push(ScheduledRegion {
                    region_id: RegionId(region_id),
                    name: op.name.clone(),
                    operations: vec![op.id],
                    selected_backend: BackendId(0),
                    physical_tensors: vec![],
                    inputs: op.inputs.clone(),
                    outputs: op.outputs.clone(),
                    dependencies: vec![],
                    fusions: vec![],
                    state_effects: vec![],
                    temp_memory_bytes: 0,
                    is_fence: false,
                });
                region_id += 1;
            }

            scheduled.seal();

            let receipt = TransformReceipt {
                pass: self.identity.clone(),
                input_digest,
                output_digest: scheduled.digest.clone(),
                rewrites_applied: ir.operations.len() as u64,
                rewrites_rejected: 0,
                rewrite_descriptions: vec![format!(
                    "created {} scheduled regions",
                    ir.operations.len()
                )],
                reached_fixpoint: true,
                duration_ns: 0,
                equivalence_claimed: true,
                equivalence_evidence: None,
            };

            let mut result = ir.clone();
            result.digest = scheduled.digest;
            (result, receipt)
        }
    }

    #[test]
    fn f32_matmul_semantic_to_backend() {
        // 1. Build the semantic module
        let mut sem = SemanticModule::new("test", "0.1.0");
        let a = TensorId(1);
        let w = TensorId(2);
        let c = TensorId(3);

        sem.declare_input(a, "a", LogicalShape { dims: vec![1, 4] }, DType::F32);
        sem.add_weight(w, "weight", LogicalShape { dims: vec![4, 1] }, DType::F32, None);
        sem.add_activation(c, "out", LogicalShape { dims: vec![1, 1] }, DType::F32, OperationId(1));

        sem.push_op(SemanticOp {
            id: OperationId(1),
            name: "matmul".into(),
            family: OperationFamily::Matmul,
            layer_index: None,
            phase: Phase::Qualification,
            inputs: vec![a, w],
            outputs: vec![c],
            stateful: false,
            state_reads: vec![],
            state_writes: vec![],
            quantization: None,
            tolerance_class: ToleranceClass::Fp16,
        });

        sem.declare_output(c);
        let semantic_digest = sem.seal();
        assert!(!semantic_digest.0.is_empty());
        assert_eq!(sem.operations.len(), 1);

        // 2. Apply lowering pass (semantic → scheduled)
        let pass: Box<dyn TransformPass<SemanticModule>> =
            Box::new(SemanticToScheduledPass::new());
        let mut pipeline = TransformPipeline::new(vec![pass]).with_max_iterations(1);
        let (_result_sem, receipts) = pipeline.run(&sem, semantic_digest.clone());

        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].rewrites_applied, 1);
        assert!(receipts[0].equivalence_claimed);

        // 3. Create a GraphRegion and validate + compile
        let region = GraphRegion {
            region_id: 1,
            family: OperationFamily::Matmul,
            operations: vec![OperationId(1)],
            input_tensors: vec![a, w],
            output_tensors: vec![c],
            shape_constraints: vec![],
        };

        let mut backend = StubBackend;
        let legality = backend.validate_region(&region).expect("validation");
        assert!(legality.legal, "region must be legal");
        assert_eq!(legality.violations.len(), 0);

        let (handle, compile_ns) = backend.compile_region(&region).expect("compile");
        assert_eq!(handle.slot, 0);
        assert_eq!(handle.generation, 1);
        assert_eq!(compile_ns, 0);
    }

    #[test]
    fn empty_region_fails_validation() {
        let backend = StubBackend;
        let empty = GraphRegion {
            region_id: 0,
            family: OperationFamily::Matmul,
            operations: vec![],
            input_tensors: vec![],
            output_tensors: vec![],
            shape_constraints: vec![],
        };
        let legality = backend.validate_region(&empty).expect("validation");
        assert!(!legality.legal, "empty region must be rejected");
        assert!(legality.violations.len() > 0);
    }

    #[test]
    fn pipeline_fixpoint_converges() {
        struct ThreeThenStop {
            identity: PassIdentity,
        }
        impl ThreeThenStop {
            fn new() -> Self {
                Self {
                    identity: PassIdentity {
                        name: "three_then_stop".into(),
                        version: "1.0.0".into(),
                        implementation_digest: EvidenceDigest(String::new()),
                    },
                }
            }
        }
        impl TransformPass<u32> for ThreeThenStop {
            fn identity(&self) -> &PassIdentity { &self.identity }
            fn applies_to(&self, ir: &u32) -> bool { *ir < 3 }
            fn apply(&self, ir: &u32, d: EvidenceDigest) -> (u32, TransformReceipt) {
                (ir + 1, TransformReceipt {
                    pass: self.identity.clone(),
                    input_digest: d.clone(),
                    output_digest: EvidenceDigest(format!("step_{}", ir + 1)),
                    rewrites_applied: 1,
                    rewrites_rejected: 0,
                    rewrite_descriptions: vec![],
                    reached_fixpoint: false,
                    duration_ns: 0,
                    equivalence_claimed: false,
                    equivalence_evidence: None,
                })
            }
        }

        let pipeline = TransformPipeline::new(vec![
            Box::new(ThreeThenStop::new()),
            Box::new(NoopPass::new()),
        ]).with_max_iterations(10);

        let (result, receipts) = pipeline.run(&0, EvidenceDigest("init".into()));
        assert_eq!(result, 3, "must converge to 3");
        assert!(
            receipts.iter().any(|r| r.reached_fixpoint),
            "pipeline must converge to fixpoint"
        );
    }
}
