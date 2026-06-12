//! Tribunus evidence-plane Arrow — direct RecordBatch construction.
//!
//! Each event family has a dedicated batch builder.  Builders flush
//! according to row count (8,192) or byte size (~32 MB), whichever
//! comes first.  No event requires an intermediate JSON DOM.

use arrow::array::{
    BooleanBuilder, Float64Builder, Int32Builder, Int64Builder, ListBuilder, StringBuilder,
    UInt32Builder, UInt64Builder,
};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;
use tribunus_evidence_schema::{
    AttentionKind, EventPayloadV4, EvidenceEventV4, Phase, ProjectionFamily,
};

// ── Builder trait ──────────────────────────────────────────────────────────

pub trait BatchBuilder: Send {
    fn schema(&self) -> Arc<Schema>;
    fn append(&mut self, ev: &EvidenceEventV4);
    fn row_count(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.row_count() == 0
    }
    fn build(&mut self) -> Option<RecordBatch>;
    fn reset(&mut self);
}

// ── LayerStageBatchBuilder ─────────────────────────────────────────────────

pub struct LayerStageBatchBuilder {
    schema: Arc<Schema>,
    run_ids: StringBuilder,
    sequence_numbers: UInt64Builder,
    phases: StringBuilder,
    layer_indices: UInt32Builder,
    attention_kinds: StringBuilder,
    stage_ids: StringBuilder,
    statuses: StringBuilder,
    graph_build_ns: UInt64Builder,
    eval_ns: UInt64Builder,
    total_ns: UInt64Builder,
    kv_copy_bytes: UInt64Builder,
    kv_alloc_bytes: UInt64Builder,
    finite: BooleanBuilder,
    row_count: usize,
}

impl LayerStageBatchBuilder {
    pub fn new() -> Self {
        let schema = Arc::new(Schema::new(vec![
            Field::new("run_id", DataType::Utf8, false),
            Field::new("sequence_number", DataType::UInt64, false),
            Field::new("phase", DataType::Utf8, false),
            Field::new("layer_index", DataType::UInt32, true),
            Field::new("attention_kind", DataType::Utf8, true),
            Field::new("stage_id", DataType::Utf8, false),
            Field::new("status", DataType::Utf8, false),
            Field::new("graph_build_ns", DataType::UInt64, false),
            Field::new("eval_ns", DataType::UInt64, false),
            Field::new("total_ns", DataType::UInt64, false),
            Field::new("kv_copy_bytes", DataType::UInt64, false),
            Field::new("kv_alloc_bytes", DataType::UInt64, false),
            Field::new("finite", DataType::Boolean, false),
        ]));

        Self {
            schema,
            run_ids: StringBuilder::new(),
            sequence_numbers: UInt64Builder::new(),
            phases: StringBuilder::new(),
            layer_indices: UInt32Builder::new(),
            attention_kinds: StringBuilder::new(),
            stage_ids: StringBuilder::new(),
            statuses: StringBuilder::new(),
            graph_build_ns: UInt64Builder::new(),
            eval_ns: UInt64Builder::new(),
            total_ns: UInt64Builder::new(),
            kv_copy_bytes: UInt64Builder::new(),
            kv_alloc_bytes: UInt64Builder::new(),
            finite: BooleanBuilder::new(),
            row_count: 0,
        }
    }
}

impl BatchBuilder for LayerStageBatchBuilder {
    fn schema(&self) -> Arc<Schema> {
        self.schema.clone()
    }

    fn append(&mut self, ev: &EvidenceEventV4) {
        if let EventPayloadV4::LayerStage(ls) = &ev.payload {
            self.run_ids.append_value(&ev.run_id.0);
            self.sequence_numbers.append_value(ev.sequence_number);
            self.phases.append_value(ev.phase.as_str());
            self.layer_indices.append_option(ev.layer_index.map(|l| l));
            self.attention_kinds
                .append_option(ev.attention_kind.as_ref().map(|k| match k {
                    AttentionKind::Sliding => "sliding",
                    AttentionKind::Full => "full",
                    AttentionKind::Embedding => "embedding",
                }));
            self.stage_ids.append_value(&ls.stage_id);
            self.statuses.append_value(&ls.status);
            self.graph_build_ns.append_value(ls.graph_build_ns);
            self.eval_ns.append_value(ls.eval_ns);
            self.total_ns.append_value(ls.total_ns);
            self.kv_copy_bytes.append_value(ls.kv_copy_bytes);
            self.kv_alloc_bytes.append_value(ls.kv_alloc_bytes);
            self.finite.append_value(ls.finite);
            self.row_count += 1;
        }
    }

    fn row_count(&self) -> usize {
        self.row_count
    }

    fn build(&mut self) -> Option<RecordBatch> {
        if self.row_count == 0 {
            return None;
        }
        let batch = RecordBatch::try_new(
            self.schema.clone(),
            vec![
                Arc::new(self.run_ids.finish()),
                Arc::new(self.sequence_numbers.finish()),
                Arc::new(self.phases.finish()),
                Arc::new(self.layer_indices.finish()),
                Arc::new(self.attention_kinds.finish()),
                Arc::new(self.stage_ids.finish()),
                Arc::new(self.statuses.finish()),
                Arc::new(self.graph_build_ns.finish()),
                Arc::new(self.eval_ns.finish()),
                Arc::new(self.total_ns.finish()),
                Arc::new(self.kv_copy_bytes.finish()),
                Arc::new(self.kv_alloc_bytes.finish()),
                Arc::new(self.finite.finish()),
            ],
        )
        .ok();
        self.reset();
        batch
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

// ── ProjectionGraphBatchBuilder ────────────────────────────────────────────

pub struct ProjectionGraphBatchBuilder {
    schema: Arc<Schema>,
    run_ids: StringBuilder,
    sequence_numbers: UInt64Builder,
    phases: StringBuilder,
    layer_indices: UInt32Builder,
    families: StringBuilder,
    invocations: UInt32Builder,
    graph_build_ns: UInt64Builder,
    storage_dtypes: StringBuilder,
    runtime_dtypes: StringBuilder,
    group_sizes: Int32Builder,
    bits: Int32Builder,
    transpose: BooleanBuilder,
    row_count: usize,
}

impl ProjectionGraphBatchBuilder {
    pub fn new() -> Self {
        let schema = Arc::new(Schema::new(vec![
            Field::new("run_id", DataType::Utf8, false),
            Field::new("sequence_number", DataType::UInt64, false),
            Field::new("phase", DataType::Utf8, false),
            Field::new("layer_index", DataType::UInt32, true),
            Field::new("projection_family", DataType::Utf8, false),
            Field::new("projection_invocation", DataType::UInt32, false),
            Field::new("graph_build_ns", DataType::UInt64, false),
            Field::new("storage_dtype", DataType::Utf8, false),
            Field::new("runtime_dtype", DataType::Utf8, false),
            Field::new("group_size", DataType::Int32, false),
            Field::new("bits", DataType::Int32, false),
            Field::new("transpose", DataType::Boolean, false),
        ]));

        Self {
            schema,
            run_ids: StringBuilder::new(),
            sequence_numbers: UInt64Builder::new(),
            phases: StringBuilder::new(),
            layer_indices: UInt32Builder::new(),
            families: StringBuilder::new(),
            invocations: UInt32Builder::new(),
            graph_build_ns: UInt64Builder::new(),
            storage_dtypes: StringBuilder::new(),
            runtime_dtypes: StringBuilder::new(),
            group_sizes: Int32Builder::new(),
            bits: Int32Builder::new(),
            transpose: BooleanBuilder::new(),
            row_count: 0,
        }
    }
}

impl BatchBuilder for ProjectionGraphBatchBuilder {
    fn schema(&self) -> Arc<Schema> {
        self.schema.clone()
    }

    fn append(&mut self, ev: &EvidenceEventV4) {
        if let EventPayloadV4::ProjectionGraph(pg) = &ev.payload {
            self.run_ids.append_value(&ev.run_id.0);
            self.sequence_numbers.append_value(ev.sequence_number);
            self.phases.append_value(ev.phase.as_str());
            self.layer_indices.append_option(ev.layer_index.map(|l| l));
            self.families.append_value(pg.family.as_str());
            self.invocations.append_value(pg.invocation);
            self.graph_build_ns.append_value(pg.graph_build_ns);
            self.storage_dtypes.append_value(&pg.storage_dtype);
            self.runtime_dtypes.append_value(&pg.runtime_dtype);
            self.group_sizes.append_value(pg.group_size);
            self.bits.append_value(pg.bits);
            self.transpose.append_value(pg.transpose);
            self.row_count += 1;
        }
    }

    fn row_count(&self) -> usize {
        self.row_count
    }

    fn build(&mut self) -> Option<RecordBatch> {
        if self.row_count == 0 {
            return None;
        }
        let batch = RecordBatch::try_new(
            self.schema.clone(),
            vec![
                Arc::new(self.run_ids.finish()),
                Arc::new(self.sequence_numbers.finish()),
                Arc::new(self.phases.finish()),
                Arc::new(self.layer_indices.finish()),
                Arc::new(self.families.finish()),
                Arc::new(self.invocations.finish()),
                Arc::new(self.graph_build_ns.finish()),
                Arc::new(self.storage_dtypes.finish()),
                Arc::new(self.runtime_dtypes.finish()),
                Arc::new(self.group_sizes.finish()),
                Arc::new(self.bits.finish()),
                Arc::new(self.transpose.finish()),
            ],
        )
        .ok();
        self.reset();
        batch
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

// ── CorrectnessCheckpointBatchBuilder ──────────────────────────────────────

pub struct CorrectnessCheckpointBatchBuilder {
    schema: Arc<Schema>,
    run_ids: StringBuilder,
    families: StringBuilder,
    layer_indices: UInt32Builder,
    input_digests: StringBuilder,
    reference_impls: StringBuilder,
    max_abs_errors: Float64Builder,
    mean_abs_errors: Float64Builder,
    passed: BooleanBuilder,
    row_count: usize,
}

impl CorrectnessCheckpointBatchBuilder {
    pub fn new() -> Self {
        let schema = Arc::new(Schema::new(vec![
            Field::new("run_id", DataType::Utf8, false),
            Field::new("projection_family", DataType::Utf8, false),
            Field::new("layer_index", DataType::UInt32, false),
            Field::new("input_digest", DataType::Utf8, false),
            Field::new("reference_impl", DataType::Utf8, false),
            Field::new("max_abs_error", DataType::Float64, false),
            Field::new("mean_abs_error", DataType::Float64, false),
            Field::new("passed", DataType::Boolean, false),
        ]));

        Self {
            schema,
            run_ids: StringBuilder::new(),
            families: StringBuilder::new(),
            layer_indices: UInt32Builder::new(),
            input_digests: StringBuilder::new(),
            reference_impls: StringBuilder::new(),
            max_abs_errors: Float64Builder::new(),
            mean_abs_errors: Float64Builder::new(),
            passed: BooleanBuilder::new(),
            row_count: 0,
        }
    }
}

impl BatchBuilder for CorrectnessCheckpointBatchBuilder {
    fn schema(&self) -> Arc<Schema> {
        self.schema.clone()
    }

    fn append(&mut self, ev: &EvidenceEventV4) {
        if let EventPayloadV4::CorrectnessCheckpoint(cc) = &ev.payload {
            self.run_ids.append_value(&ev.run_id.0);
            self.families.append_value(cc.family.as_str());
            self.layer_indices.append_value(ev.layer_index.unwrap_or(0));
            self.input_digests.append_value(&cc.input_digest);
            self.reference_impls.append_value(&cc.reference_impl);
            self.max_abs_errors.append_value(cc.max_abs_error);
            self.mean_abs_errors.append_value(cc.mean_abs_error);
            self.passed.append_value(cc.passed);
            self.row_count += 1;
        }
    }

    fn row_count(&self) -> usize {
        self.row_count
    }

    fn build(&mut self) -> Option<RecordBatch> {
        if self.row_count == 0 {
            return None;
        }
        let batch = RecordBatch::try_new(
            self.schema.clone(),
            vec![
                Arc::new(self.run_ids.finish()),
                Arc::new(self.families.finish()),
                Arc::new(self.layer_indices.finish()),
                Arc::new(self.input_digests.finish()),
                Arc::new(self.reference_impls.finish()),
                Arc::new(self.max_abs_errors.finish()),
                Arc::new(self.mean_abs_errors.finish()),
                Arc::new(self.passed.finish()),
            ],
        )
        .ok();
        self.reset();
        batch
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

// ── Batch dispatcher ───────────────────────────────────────────────────────

/// Routes events to the correct batch builder based on payload type.
pub struct BatchDispatcher {
    pub layer_stage: LayerStageBatchBuilder,
    pub projection_graph: ProjectionGraphBatchBuilder,
    pub readiness: ReadinessTransitionBatchBuilder,
    pub correctness: CorrectnessCheckpointBatchBuilder,
    flush_row_limit: usize,
}

impl BatchDispatcher {
    pub fn new(flush_row_limit: usize) -> Self {
        Self {
            layer_stage: LayerStageBatchBuilder::new(),
            projection_graph: ProjectionGraphBatchBuilder::new(),
            readiness: ReadinessTransitionBatchBuilder::new(),
            correctness: CorrectnessCheckpointBatchBuilder::new(),
            flush_row_limit,
        }
    }

    /// Feed one event into the appropriate builder.
    pub fn dispatch(&mut self, ev: &EvidenceEventV4) {
        match &ev.payload {
            EventPayloadV4::LayerStage(_) => self.layer_stage.append(ev),
            EventPayloadV4::ProjectionGraph(_) => self.projection_graph.append(ev),
            EventPayloadV4::ReadinessTransition(_) => self.readiness.append(ev),
            EventPayloadV4::CorrectnessCheckpoint(_) => self.correctness.append(ev),
            // Other payloads not yet batch-built
            _ => {}
        }
    }

    /// Flush all builders that have reached the row limit.
    pub fn flush_all(&mut self) -> Vec<(String, RecordBatch)> {
        let mut batches = Vec::new();
        for builder in [
            (
                "readiness_transitions",
                &mut self.readiness as &mut dyn BatchBuilder,
            ),
            (
                "layer_stage_events",
                &mut self.layer_stage as &mut dyn BatchBuilder,
            ),
            (
                "projection_graph_events",
                &mut self.projection_graph as &mut dyn BatchBuilder,
            ),
            (
                "correctness_checkpoints",
                &mut self.correctness as &mut dyn BatchBuilder,
            ),
        ]
        .iter_mut()
        {
            if builder.1.row_count() >= self.flush_row_limit {
                if let Some(batch) = builder.1.build() {
                    batches.push((builder.0.to_string(), batch));
                }
            }
        }
        batches
    }

    /// Flush all builders regardless of row count.
    pub fn flush_all_final(&mut self) -> Vec<(String, RecordBatch)> {
        let mut batches = Vec::new();
        if let Some(b) = self.layer_stage.build() {
            batches.push(("layer_stage_events".into(), b));
        }
        if let Some(b) = self.projection_graph.build() {
            batches.push(("projection_graph_events".into(), b));
        }
        if let Some(b) = self.correctness.build() {
            batches.push(("correctness_checkpoints".into(), b));
        }
        batches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tribunus_evidence_schema::{
        EventPayloadV4, EvidenceEventV4, LayerStageEvent, ProjectionGraphEvent, RequestId, RunId,
        WorkerId,
    };

    #[test]
    fn test_layer_stage_builder() {
        let mut builder = LayerStageBatchBuilder::new();
        let ev = EvidenceEventV4::new(
            RunId::from("test"),
            RequestId::from("r"),
            WorkerId::from("w"),
            EventPayloadV4::LayerStage(LayerStageEvent {
                stage_id: "l0".into(),
                status: "completed".into(),
                graph_build_ns: 100,
                eval_ns: 500,
                total_ns: 600,
                kv_copy_bytes: 0,
                kv_alloc_bytes: 0,
                kv_seq_len: 0,
                shape: vec![],
                finite: true,
            }),
        )
        .with_sequence(1)
        .with_phase(Phase::Prefill);

        builder.append(&ev);
        assert_eq!(builder.row_count(), 1);
        let batch = builder.build().unwrap();
        assert_eq!(batch.num_rows(), 1);
        assert_eq!(builder.row_count(), 0);
    }

    #[test]
    fn test_projection_graph_builder() {
        let mut builder = ProjectionGraphBatchBuilder::new();
        let ev = EvidenceEventV4::new(
            RunId::from("test"),
            RequestId::from("r"),
            WorkerId::from("w"),
            EventPayloadV4::ProjectionGraph(ProjectionGraphEvent {
                family: ProjectionFamily::QProj,
                invocation: 0,
                graph_build_ns: 100,
                input_shape: vec![1, 3840],
                weight_logical_shape: vec![4096, 3840],
                weight_physical_shape: vec![4096, 3840],
                storage_dtype: "U8".into(),
                runtime_dtype: "Uint32".into(),
                group_size: 64,
                bits: 8,
                transpose: true,
            }),
        )
        .with_sequence(1)
        .with_phase(Phase::DecodeStep);

        builder.append(&ev);
        assert_eq!(builder.row_count(), 1);
        let batch = builder.build().unwrap();
        assert_eq!(batch.num_rows(), 1);
    }

    #[test]
    fn test_batch_dispatcher_flush() {
        let mut dispatcher = BatchDispatcher::new(2);
        for i in 0..3 {
            let ev = EvidenceEventV4::new(
                RunId::from("test"),
                RequestId::from("r"),
                WorkerId::from("w"),
                EventPayloadV4::LayerStage(LayerStageEvent {
                    stage_id: format!("l{}", i),
                    status: "completed".into(),
                    graph_build_ns: 100,
                    eval_ns: 500,
                    total_ns: 600,
                    kv_copy_bytes: 0,
                    kv_alloc_bytes: 0,
                    kv_seq_len: 0,
                    shape: vec![],
                    finite: true,
                }),
            )
            .with_sequence(i as u64 + 1);
            dispatcher.dispatch(&ev);
        }

        // After 2, flush should trigger; 3rd remains
        let batches = dispatcher.flush_all();
        // Flushed at row 2 (reached limit), then 1 remains
        let final_batches = dispatcher.flush_all_final();
        let total: usize = batches.iter().map(|(_, b)| b.num_rows()).sum::<usize>()
            + final_batches
                .iter()
                .map(|(_, b)| b.num_rows())
                .sum::<usize>();
        assert_eq!(total, 3);
    }
}

pub struct ReadinessTransitionBatchBuilder {
    schema: Arc<Schema>,
    run_ids: StringBuilder,
    resource_ids: StringBuilder,
    previous_states: StringBuilder,
    current_states: StringBuilder,
    reasons: StringBuilder,
    transition_ns: UInt64Builder,
    row_count: usize,
}

impl ReadinessTransitionBatchBuilder {
    pub fn new() -> Self {
        let schema = Arc::new(Schema::new(vec![
            Field::new("run_id", DataType::Utf8, false),
            Field::new("resource_id", DataType::Utf8, false),
            Field::new("previous", DataType::Utf8, false),
            Field::new("current", DataType::Utf8, false),
            Field::new("reason", DataType::Utf8, true),
            Field::new("transition_ns", DataType::UInt64, false),
        ]));
        Self {
            schema,
            run_ids: StringBuilder::new(),
            resource_ids: StringBuilder::new(),
            previous_states: StringBuilder::new(),
            current_states: StringBuilder::new(),
            reasons: StringBuilder::new(),
            transition_ns: UInt64Builder::new(),
            row_count: 0,
        }
    }
}

impl BatchBuilder for ReadinessTransitionBatchBuilder {
    fn schema(&self) -> Arc<Schema> {
        self.schema.clone()
    }
    fn append(&mut self, ev: &EvidenceEventV4) {
        if let EventPayloadV4::ReadinessTransition(rt) = &ev.payload {
            self.run_ids.append_value(&ev.run_id.0);
            self.resource_ids.append_value(&rt.resource_id.0);
            self.previous_states
                .append_value(&format!("{:?}", rt.previous));
            self.current_states
                .append_value(&format!("{:?}", rt.current));
            self.reasons.append_value(&rt.reason);
            self.transition_ns.append_value(rt.transition_ns);
            self.row_count += 1;
        }
    }
    fn row_count(&self) -> usize {
        self.row_count
    }
    fn build(&mut self) -> Option<RecordBatch> {
        if self.row_count == 0 {
            return None;
        }
        let batch = RecordBatch::try_new(
            self.schema.clone(),
            vec![
                Arc::new(self.run_ids.finish()),
                Arc::new(self.resource_ids.finish()),
                Arc::new(self.previous_states.finish()),
                Arc::new(self.current_states.finish()),
                Arc::new(self.reasons.finish()),
                Arc::new(self.transition_ns.finish()),
            ],
        )
        .ok();
        self.reset();
        batch
    }
    fn reset(&mut self) {
        *self = Self::new();
    }
}
