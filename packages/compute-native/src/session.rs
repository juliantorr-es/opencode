//! ModelSession — native model ownership and lifecycle.
//!
//! A ModelSession owns the compiled plan, weight handles, shared embedding
//! storage, native device identity, and active generation jobs.
//!
//! Lifecycle: created → validating → loading → ready → draining → released.
//! Failed states release all allocations.

use crate::bridge::ARRAY_REGISTRY;
use crate::config::{ExecutionSpec, NamespaceBinding, QuantizationMeta, TextArchitecture};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// Model lifecycle state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleState {
    Created,
    Validating,
    Loading,
    Ready,
    Draining,
    Released,
    Failed,
}

/// A native model session owning all resources for one loaded model.
pub struct ModelSession {
    state: LifecycleState,
    arch: TextArchitecture,
    spec: ExecutionSpec,
    session_id: u64,
    /// Handles for global tensors (embedding, final norm, lm_head).
    global_handles: Vec<u64>,
    /// Per-layer compiled quantized bindings — resolved once, no string lookups.
    layer_bindings: Vec<LayerExecutionPlan>,
    /// Active generation count (for drain-before-release safety).
    active_jobs: AtomicU32,
}

/// Compile-time resolved execution plan for one decoder layer.
pub struct LayerExecutionPlan {
    pub index: u32,
    pub is_full_attention: bool,
    // Quantized linear bindings (handle triples)
    pub q_proj: QuantizedBinding,
    pub k_proj: QuantizedBinding,
    pub v_proj: Option<QuantizedBinding>,
    pub o_proj: QuantizedBinding,
    pub gate_proj: QuantizedBinding,
    pub up_proj: QuantizedBinding,
    pub down_proj: QuantizedBinding,
    // Norm handles
    pub attn_norm: u64,
    pub ffn_norm: u64,
    pub q_norm: u64,
    pub k_norm: u64,
    // Dimensions
    pub n_heads: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub n_rep: u32,
    pub q_out: u32,
    pub kv_out: u32,
}

/// A resolved quantized linear binding — weight + scales + biases handles.
pub struct QuantizedBinding {
    pub weight: u64,
    pub scales: u64,
    pub biases: u64,
    pub in_dim: u32,
    pub out_dim: u32,
    pub group_size: u32,
    pub bits: u32,
}

impl ModelSession {
    /// Create a new session from validated config and bindings.
    /// All weight handles must already be registered in the global registry.
    pub fn new(arch: TextArchitecture, spec: ExecutionSpec, session_id: u64) -> Self {
        Self {
            state: LifecycleState::Created,
            arch,
            spec,
            session_id,
            global_handles: Vec::new(),
            layer_bindings: Vec::new(),
            active_jobs: AtomicU32::new(0),
        }
    }

    /// Transition to Ready after loading completes.
    pub fn mark_ready(&mut self) -> Result<(), String> {
        match self.state {
            LifecycleState::Loading => {
                self.state = LifecycleState::Ready;
                Ok(())
            }
            s => Err(format!("Cannot mark ready from state {:?}", s)),
        }
    }

    /// Begin draining: reject new jobs, allow existing jobs to finish.
    pub fn drain(&mut self) -> Result<(), String> {
        match self.state {
            LifecycleState::Ready => {
                self.state = LifecycleState::Draining;
                Ok(())
            }
            s => Err(format!("Cannot drain from state {:?}", s)),
        }
    }

    /// Release all resources. Must not be called with active Metal work in flight.
    pub fn release(&mut self) {
        for handle in &self.global_handles {
            let _ = crate::bridge::free_array(*handle);
        }
        for layer in &self.layer_bindings {
            for h in layer.all_handles() {
                let _ = crate::bridge::free_array(h);
            }
        }
        self.state = LifecycleState::Released;
    }

    pub fn state(&self) -> LifecycleState {
        self.state
    }
    pub fn session_id(&self) -> u64 {
        self.session_id
    }

    /// Increment active job count. Returns false if draining/released.
    pub fn acquire_job(&self) -> bool {
        if self.state != LifecycleState::Ready {
            return false;
        }
        self.active_jobs.fetch_add(1, Ordering::SeqCst);
        true
    }

    /// Decrement active job count.
    pub fn release_job(&self) {
        self.active_jobs.fetch_sub(1, Ordering::SeqCst);
    }

    /// Wait for all active jobs to complete before releasing.
    pub fn active_jobs(&self) -> u32 {
        self.active_jobs.load(Ordering::SeqCst)
    }
}

impl LayerExecutionPlan {
    fn all_handles(&self) -> Vec<u64> {
        let mut h = vec![self.attn_norm, self.ffn_norm, self.q_norm, self.k_norm];
        for b in [
            &self.q_proj,
            &self.k_proj,
            &self.o_proj,
            &self.gate_proj,
            &self.up_proj,
            &self.down_proj,
        ] {
            h.push(b.weight);
            h.push(b.scales);
            h.push(b.biases);
        }
        if let Some(ref v) = self.v_proj {
            h.push(v.weight);
            h.push(v.scales);
            h.push(v.biases);
        }
        h
    }
}

// ── Async Generation API (scaffold) ────────────────────────────────────────

/// A generation job — runs token-by-token decode on a background thread.
///
/// Created by ModelSession::start_generation(). The N-API async task
/// model executes native computation outside the JavaScript main thread.
pub struct GenerationJob {
    session_id: u64,
    job_id: u64,
    cancelled: Arc<AtomicU32>,
    /// Maximum tokens to generate (0 = unlimited until EOS).
    max_tokens: u32,
    /// Tokens generated so far.
    generated: AtomicU32,
}

impl GenerationJob {
    pub fn new(session_id: u64, job_id: u64, max_tokens: u32) -> Self {
        Self {
            session_id,
            job_id,
            cancelled: Arc::new(AtomicU32::new(0)),
            max_tokens,
            generated: AtomicU32::new(0),
        }
    }

    /// Check if generation should stop.
    pub fn should_continue(&self) -> bool {
        if self.cancelled.load(Ordering::SeqCst) != 0 {
            return false;
        }
        if self.max_tokens > 0 && self.generated.load(Ordering::SeqCst) >= self.max_tokens {
            return false;
        }
        true
    }

    /// Signal cancellation. Returns immediately — the decode loop checks
    /// should_continue() between steps and exits cleanly.
    pub fn cancel(&self) {
        self.cancelled.store(1, Ordering::SeqCst);
    }

    pub fn record_token(&self) -> u32 {
        self.generated.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn job_id(&self) -> u64 {
        self.job_id
    }
}

// ── Async N-API integration (scaffold) ─────────────────────────────────────

/// Production API: start generation asynchronously.
///
/// This would be exposed as a napi async function. The heavy computation
/// runs outside the JavaScript main thread via napi-rs's AsyncTask.
///
/// The callback receives token events: { tokenId, index, eos, topK? }.
///
/// Implementation sketch (not compiled):
///
/// ```rust
/// #[napi(ts_return_type = "Promise<GenerationResult>")]
/// pub fn generate_async(
///     session_id: i64,
///     input_ids: Buffer,
///     max_tokens: u32,
///     temperature: Option<f64>,
/// ) -> napi::Result<AsyncTask<GenerateTask>> {
///     Ok(AsyncTask::new(GenerateTask { session_id, input_ids, max_tokens, temperature }))
/// }
///
/// struct GenerateTask { /* ... */ }
/// impl napi::Task for GenerateTask {
///     type Output = GenerationResult;
///     type JsValue = JsObject;
///     fn compute(&mut self) -> Result<Self::Output> { /* run on worker thread */ }
///     fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> { /* return to JS */ }
/// }
/// ```

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lifecycle_transitions() {
        let arch = TextArchitecture {
            hidden_size: 3840,
            intermediate_size: 15360,
            num_attention_heads: 16,
            num_key_value_heads: 8,
            head_dim: 256,
            global_head_dim: Some(512),
            num_global_key_value_heads: Some(1),
            num_hidden_layers: 48,
            vocab_size: 262144,
            sliding_window: 1024,
            max_position_embeddings: 131072,
            rms_norm_eps: 1e-6,
            tie_word_embeddings: true,
            attention_k_eq_v: true,
            final_logit_softcapping: Some(30.0),
            hidden_size_per_layer_input: 0,
            layer_types: vec![
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::FullAttention,
            ],
            rope_local: crate::config::RopeSpec {
                theta: 10000.0,
                rope_type: "default".into(),
                partial_rotary_factor: None,
            },
            rope_global: Some(crate::config::RopeSpec {
                theta: 1000000.0,
                rope_type: "proportional".into(),
                partial_rotary_factor: Some(0.25),
            }),
            model_type: "gemma4_text".into(),
        };
        let binding = NamespaceBinding {
            root: "model".into(),
            discovery: "test".into(),
            lm_head_key: "model.embed_tokens.weight".into(),
            lm_head_aliased: true,
        };
        let spec = crate::config::compile(&arch, &binding, None);

        let mut session = ModelSession::new(arch, spec, 1);
        assert_eq!(session.state(), LifecycleState::Created);

        // Cannot go to Ready directly from Created
        assert!(session.mark_ready().is_err());

        // Drain from Created should fail
        assert!(session.drain().is_err());

        // Acquire job from non-Ready should fail
        assert!(!session.acquire_job());

        // Transition through Loading (simulated)
        session.state = LifecycleState::Loading;
        assert!(session.mark_ready().is_ok());
        assert_eq!(session.state(), LifecycleState::Ready);

        // Job acquisition from Ready
        assert!(session.acquire_job());
        assert_eq!(session.active_jobs(), 1);
        session.release_job();
        assert_eq!(session.active_jobs(), 0);

        // Drain from Ready
        assert!(session.drain().is_ok());
        assert_eq!(session.state(), LifecycleState::Draining);

        // Cannot acquire job while draining
        assert!(!session.acquire_job());

        // Release
        session.release();
        assert_eq!(session.state(), LifecycleState::Released);
    }

    #[test]
    fn test_generation_job_cancellation() {
        let job = GenerationJob::new(1, 100, 50);
        assert!(job.should_continue());
        assert_eq!(job.record_token(), 1);

        job.cancel();
        assert!(!job.should_continue());

        let job2 = GenerationJob::new(1, 101, 3);
        for _ in 0..3 {
            job2.record_token();
        }
        assert!(!job2.should_continue()); // max_tokens reached
    }
}
