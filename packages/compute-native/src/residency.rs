//! Bounded MLX device memory residency manager.
//!
//! Tracks segment lifecycle (prefetched → bound → in-flight → retired)
//! against a fixed memory budget with a configurable safety reserve.
//! The manager itself is a lightweight admission controller: callers
//! supply byte sizes at admission time and the manager tracks identity,
//! not cumulative byte counters.

use napi::Status;

/// Lifecycle state of a segment lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentLeaseState {
    Prefetched,
    Bound,
    InFlight,
    Retired,
}

/// A tracked segment lease within the residency manager.
#[derive(Debug, Clone)]
pub struct SegmentLease {
    pub segment_id: String,
    pub byte_size: u64,
    pub state: SegmentLeaseState,
}

/// Bounded memory residency manager for MLX device segments.
///
/// Ensures segments are admitted only within the configured budget,
/// and enforces a valid lifecycle transition graph:
///
/// ```text
/// ┌──────────┐    request_prefetch     ┌────────────┐
/// │  absent  │ ──────────────────────→ │ Prefetched  │
/// └──────────┘                         └──────┬─────┘
///                                              │ bind_segment
///                                              ↓
///                                       ┌──────────┐
///                                       │  Bound   │
///                                       └─────┬────┘
///                                             │ mark_in_flight
///                                             ↓
///                                       ┌───────────┐
///                                       │ InFlight  │
///                                       └─────┬─────┘
///                                             │ retire
///                                             ↓
///                                       ┌──────────┐
///                                       │ Retired  │
///                                       └──────────┘
/// ```
#[derive(Debug, Clone)]
pub struct ResidencyManager {
    /// Total memory budget in bytes for all admitted segments.
    pub memory_budget_bytes: u64,
    /// Reserve bytes that the manager refuses to admit into.
    pub safety_reserve_bytes: u64,
    /// Segment identifiers that have been requested but not yet prefetched.
    pub active_segments: Vec<String>,
    /// Segment identifiers currently in the prefetched state.
    pub prefetched: Vec<String>,
    /// Segment identifiers currently bound (loaded but not executing).
    pub bound: Vec<String>,
    /// Single segment currently in-flight (executing), if any.
    pub in_flight: Option<String>,
}

impl ResidencyManager {
    /// Create a new residency manager with the given budget and safety reserve.
    ///
    /// `safety_reserve_bytes` is kept free; `can_admit` returns `false` for
    /// any segment whose size exceeds `budget_bytes - safety_reserve_bytes`.
    pub fn new(budget_bytes: u64, safety_reserve_bytes: u64) -> Self {
        Self {
            memory_budget_bytes: budget_bytes,
            safety_reserve_bytes,
            active_segments: Vec::new(),
            prefetched: Vec::new(),
            bound: Vec::new(),
            in_flight: None,
        }
    }

    /// Whether `segment_bytes` fits within the budget after accounting for
    /// the safety reserve.
    ///
    /// This is a simple admission gate — it does **not** track cumulative
    /// usage across admitted segments.
    pub fn can_admit(&self, segment_bytes: u64) -> bool {
        segment_bytes <= self.memory_budget_bytes.saturating_sub(self.safety_reserve_bytes)
    }

    /// Request a segment be prefetched, subject to budget.
    ///
    /// Returns `true` and adds `segment_id` to `prefetched` if the segment
    /// fits within the budget. Returns `false` otherwise.
    pub fn request_prefetch(&mut self, segment_id: &str, byte_size: u64) -> bool {
        if !self.can_admit(byte_size) {
            return false;
        }
        self.active_segments.push(segment_id.to_string());
        self.prefetched.push(segment_id.to_string());
        true
    }

    /// Transition a segment from `Prefetched` to `Bound`.
    ///
    /// # Errors
    ///
    /// Returns `napi::Error` with `InvalidArgument` if the segment is not in
    /// the prefetched list.
    pub fn bind_segment(&mut self, segment_id: &str) -> napi::Result<()> {
        let idx = self
            .prefetched
            .iter()
            .position(|id| id == segment_id)
            .ok_or_else(|| {
                napi::Error::new(
                    Status::InvalidArg,
                    format!(
                        "segment '{}' is not in prefetched state; cannot bind",
                        segment_id
                    ),
                )
            })?;
        self.prefetched.swap_remove(idx);
        self.bound.push(segment_id.to_string());
        Ok(())
    }

    /// Mark a segment as currently executing (InFlight).
    ///
    /// The segment must be in the `Bound` state. Only one segment may be
    /// in-flight at a time.
    ///
    /// # Errors
    ///
    /// Returns `napi::Error` with `InvalidArgument` if the segment is not
    /// bound, or `Conflict` if another segment is already in-flight.
    pub fn mark_in_flight(&mut self, segment_id: &str) -> napi::Result<()> {
        let idx = self
            .bound
            .iter()
            .position(|id| id == segment_id)
            .ok_or_else(|| {
                napi::Error::new(
                    Status::InvalidArg,
                    format!(
                        "segment '{}' is not in bound state; cannot mark in-flight",
                        segment_id
                    ),
                )
            })?;

        if self.in_flight.is_some() {
            return Err(napi::Error::new(
                Status::GenericFailure,
                "a segment is already in-flight; retire it first".to_string(),
            ));
        }

        self.bound.swap_remove(idx);
        self.in_flight = Some(segment_id.to_string());
        Ok(())
    }

    /// Release all tracked state for a segment.
    ///
    /// Removes `segment_id` from `active_segments`, `prefetched`, `bound`,
    /// and clears `in_flight` if it matches. Idempotent — safe to call for
    /// segments not currently tracked.
    pub fn retire(&mut self, segment_id: &str) {
        self.active_segments.retain(|id| id != segment_id);
        self.prefetched.retain(|id| id != segment_id);
        self.bound.retain(|id| id != segment_id);
        if self.in_flight.as_deref() == Some(segment_id) {
            self.in_flight = None;
        }
    }

    /// Returns a reference to the list of all tracked segment identifiers
    /// that have been requested (across all lifecycle states).
    pub fn active_list(&self) -> &[String] {
        &self.active_segments
    }

    /// Whether the manager has no bound or in-flight segments.
    ///
    /// Prefetched-but-not-yet-bound segments do not count as "active" for
    /// this check.
    pub fn idle(&self) -> bool {
        self.bound.is_empty() && self.in_flight.is_none()
    }
}

impl SegmentLease {
    pub fn new(segment_id: impl Into<String>, byte_size: u64, state: SegmentLeaseState) -> Self {
        Self {
            segment_id: segment_id.into(),
            byte_size,
            state,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_manager_has_no_active_segments() {
        let mgr = ResidencyManager::new(1024, 128);
        assert_eq!(mgr.memory_budget_bytes, 1024);
        assert_eq!(mgr.safety_reserve_bytes, 128);
        assert!(mgr.active_segments.is_empty());
        assert!(mgr.prefetched.is_empty());
        assert!(mgr.bound.is_empty());
        assert!(mgr.in_flight.is_none());
        assert!(mgr.idle());
    }

    #[test]
    fn test_can_admit_respects_safety_reserve() {
        let mgr = ResidencyManager::new(1024, 256);
        // 768 is the effective budget (1024 - 256)
        assert!(mgr.can_admit(768));
        assert!(!mgr.can_admit(769));
    }

    #[test]
    fn test_request_prefetch_accepts_within_budget() {
        let mut mgr = ResidencyManager::new(1024, 0);
        assert!(mgr.request_prefetch("seg_a", 500));
        assert!(mgr.prefetched.contains(&"seg_a".to_string()));
        assert!(mgr.active_segments.contains(&"seg_a".to_string()));
    }

    #[test]
    fn test_request_prefetch_rejects_oversized() {
        let mut mgr = ResidencyManager::new(1024, 128);
        assert!(!mgr.request_prefetch("big_seg", 1024));
        assert!(!mgr.prefetched.contains(&"big_seg".to_string()));
    }

    #[test]
    fn test_bind_segment_moves_from_prefetched() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        assert!(!mgr.prefetched.contains(&"seg_a".to_string()));
        assert!(mgr.bound.contains(&"seg_a".to_string()));
    }

    #[test]
    fn test_bind_segment_fails_when_not_prefetched() {
        let mut mgr = ResidencyManager::new(1024, 0);
        let err = mgr.bind_segment("unknown").unwrap_err();
        assert_eq!(err.status, Status::InvalidArg);
    }

    #[test]
    fn test_mark_in_flight_moves_from_bound() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        mgr.mark_in_flight("seg_a").unwrap();
        assert!(!mgr.bound.contains(&"seg_a".to_string()));
        assert_eq!(mgr.in_flight.as_deref(), Some("seg_a"));
    }

    #[test]
    fn test_mark_in_flight_fails_when_not_bound() {
        let mut mgr = ResidencyManager::new(1024, 0);
        let err = mgr.mark_in_flight("unknown").unwrap_err();
        assert_eq!(err.status, Status::InvalidArg);
    }

    #[test]
    fn test_mark_in_flight_fails_on_conflict() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        mgr.mark_in_flight("seg_a").unwrap();

        mgr.request_prefetch("seg_b", 256);
        mgr.bind_segment("seg_b").unwrap();
        let err = mgr.mark_in_flight("seg_b").unwrap_err();
        assert_eq!(err.status, Status::GenericFailure);
    }

    #[test]
    fn test_retire_clears_all_state() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        mgr.mark_in_flight("seg_a").unwrap();

        mgr.retire("seg_a");
        assert!(!mgr.active_segments.contains(&"seg_a".to_string()));
        assert!(!mgr.prefetched.contains(&"seg_a".to_string()));
        assert!(!mgr.bound.contains(&"seg_a".to_string()));
        assert!(mgr.in_flight.is_none());
        assert!(mgr.idle());
    }

    #[test]
    fn test_retire_is_idempotent() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.retire("never_added"); // should not panic
        assert!(mgr.idle());
    }

    #[test]
    fn test_active_list() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.request_prefetch("seg_b", 256);
        assert_eq!(mgr.active_list().len(), 2);
    }

    #[test]
    fn test_idle_false_when_bound() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        assert!(!mgr.idle());
    }

    #[test]
    fn test_idle_false_when_in_flight() {
        let mut mgr = ResidencyManager::new(1024, 0);
        mgr.request_prefetch("seg_a", 256);
        mgr.bind_segment("seg_a").unwrap();
        mgr.mark_in_flight("seg_a").unwrap();
        assert!(!mgr.idle());
    }

    #[test]
    fn test_full_lifecycle() {
        let mut mgr = ResidencyManager::new(4096, 512);
        // effective budget = 3584
        assert!(mgr.can_admit(3584));

        assert!(mgr.request_prefetch("segment_0", 2048));
        assert!(mgr.request_prefetch("segment_1", 1024));

        mgr.bind_segment("segment_0").unwrap();
        assert!(mgr.prefetched.contains(&"segment_1".to_string()));
        assert!(mgr.bound.contains(&"segment_0".to_string()));

        mgr.mark_in_flight("segment_0").unwrap();
        assert_eq!(mgr.in_flight.as_deref(), Some("segment_0"));

        mgr.retire("segment_0");
        assert!(mgr.active_segments.contains(&"segment_1".to_string()));
        // prefetched-only does not count as non-idle per spec
        assert!(mgr.idle());

        mgr.retire("segment_1");
        assert!(mgr.idle());
    }

    #[test]
    fn test_segment_lease_new() {
        let lease = SegmentLease::new("seg_a", 512, SegmentLeaseState::Bound);
        assert_eq!(lease.segment_id, "seg_a");
        assert_eq!(lease.byte_size, 512);
        assert_eq!(lease.state, SegmentLeaseState::Bound);
    }
}
