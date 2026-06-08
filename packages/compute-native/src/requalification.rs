//! Profile requalification — evidence-based promotion and deprecation of
//! placement profiles.
//!
//! A placement profile is never trusted indefinitely. After a profile enters
//! production, the requalifier collects runtime evidence (token throughput,
//! boundary latency, device activity) and decides whether the profile should
//! be promoted, deprecated, or left unchanged.
//!
//! # Evidence model
//!
//! Every evaluation compares the **oracle** (compile-time token estimate)
//! against the **candidate** (measured runtime throughput).  If the candidate
//! consistently meets or exceeds the oracle, the profile qualifies for
//! promotion to the preferred tier.  Degradation triggers deprecation.
//!
//! `ProfileEvidence` is a single observation.  The caller accumulates
//! multiple observations over time and calls `promote_to_preferred` when
//! the aggregate satisfies the promotion threshold.

use serde::{Deserialize, Serialize};
use std::path::Path;

// ---------------------------------------------------------------------------
// ProfileEvidence
// ---------------------------------------------------------------------------

/// A single observation of a placement profile's execution quality.
///
/// Every field is measured at runtime and compared against the compile-time
/// oracle estimate to determine whether the profile still performs as
/// expected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEvidence {
    /// The placement profile this evidence applies to (image hash or UUID).
    pub profile_id: String,

    /// Token throughput predicted by the compiler/oracle (tokens/s).
    pub oracle_tokens: f64,

    /// Token throughput actually observed at runtime (tokens/s).
    pub candidate_tokens: f64,

    /// Ratio `candidate_tokens / oracle_tokens`.  Values >= 1.0 indicate
    /// the candidate meets or exceeds the oracle prediction.
    pub token_parity: f64,

    /// Measured latency overhead for the slowest boundary transition in this
    /// profile's execution, in microseconds.  0.0 if no boundary was crossed.
    pub boundary_latency_us: f64,

    /// Fraction of wall-clock time the target device was active during the
    /// profiled window, in [0.0, 1.0].  May be derived from Metal
    /// `MTLDevice` counters or from `mlx_active_memory()` deltas.
    pub device_activity: f64,
}

impl ProfileEvidence {
    /// Construct a new evidence observation from raw measurements.
    ///
    /// `token_parity` is computed automatically as
    /// `candidate_tokens / oracle_tokens` (clamped to 0.0 when the oracle
    /// is unreachable, i.e. `oracle_tokens` is 0.0 or NaN).
    pub fn new(
        profile_id: String,
        oracle_tokens: f64,
        candidate_tokens: f64,
        boundary_latency_us: f64,
        device_activity: f64,
    ) -> Self {
        let token_parity = if oracle_tokens > 0.0 && oracle_tokens.is_finite() {
            candidate_tokens / oracle_tokens
        } else {
            0.0
        };

        Self {
            profile_id,
            oracle_tokens,
            candidate_tokens,
            token_parity,
            boundary_latency_us,
            device_activity: device_activity.clamp(0.0, 1.0),
        }
    }

    /// Returns `true` when the candidate meets or exceeds the oracle
    /// prediction (token_parity >= 1.0) with reasonable confidence.
    pub fn is_meeting_oracle(&self) -> bool {
        self.token_parity >= 1.0 && self.token_parity.is_finite()
    }

    /// Returns `true` when the candidate is significantly below the oracle
    /// (token_parity < 0.85), suggesting the profile may need deprecation.
    pub fn is_degraded(&self) -> bool {
        self.token_parity < 0.85 || (!self.token_parity.is_finite())
    }
}

// ---------------------------------------------------------------------------
// Requalifier
// ---------------------------------------------------------------------------

/// Determines whether a placement profile should be promoted, deprecated,
/// or left unchanged based on collected evidence.
///
/// The requalifier operates on a sliding window of [`ProfileEvidence`]
/// observations.  Promotion requires a configurable minimum number of
/// consecutive observations where the candidate meets or exceeds the oracle.
pub struct Requalifier {
    /// Minimum number of qualifying evidence observations required before
    /// a candidate profile is promoted to preferred tier.
    pub promotion_window: usize,

    /// Required `token_parity` threshold for promotion (default 1.0).
    pub promotion_threshold: f64,

    /// Required `device_activity` minimum for a valid observation
    /// (default 0.5 — the device must be active at least 50% of the window).
    pub min_device_activity: f64,
}

impl Default for Requalifier {
    fn default() -> Self {
        Self {
            promotion_window: 3,
            promotion_threshold: 1.0,
            min_device_activity: 0.5,
        }
    }
}

impl Requalifier {
    /// Create a new Requalifier with the given parameters.
    pub fn new(
        promotion_window: usize,
        promotion_threshold: f64,
        min_device_activity: f64,
    ) -> Self {
        Self {
            promotion_window,
            promotion_threshold,
            min_device_activity,
        }
    }

    /// Collect a single evidence observation.
    ///
    /// This is a factory helper that constructs [`ProfileEvidence`] from
    /// raw measurements.  The caller is responsible for accumulating multiple
    /// observations and passing them to [`promote_to_preferred`].
    pub fn collect_evidence(
        &self,
        profile_id: String,
        oracle_tokens: f64,
        candidate_tokens: f64,
        boundary_latency_us: f64,
        device_activity: f64,
    ) -> ProfileEvidence {
        ProfileEvidence::new(
            profile_id,
            oracle_tokens,
            candidate_tokens,
            boundary_latency_us,
            device_activity,
        )
    }

    /// Evaluate a batch of evidence observations and decide whether the
    /// profile qualifies for promotion.
    ///
    /// Returns `Ok(())` when the sliding window contains at least
    /// `promotion_window` consecutive qualifying observations where:
    ///
    /// - `token_parity >= promotion_threshold`
    /// - `device_activity >= min_device_activity`
    ///
    /// Returns `Err(reason)` describing the first failure otherwise.
    pub fn promote_to_preferred(
        &self,
        evidence: &[ProfileEvidence],
        profile_id: &str,
    ) -> Result<(), String> {
        if evidence.is_empty() {
            return Err("cannot promote: no evidence collected".into());
        }

        // Filter observations for this profile only.
        let relevant: Vec<&ProfileEvidence> = evidence
            .iter()
            .filter(|e| e.profile_id == profile_id)
            .collect();

        if relevant.len() < self.promotion_window {
            return Err(format!(
                "cannot promote: need {} observations for profile '{}', got {}",
                self.promotion_window,
                profile_id,
                relevant.len()
            ));
        }

        // Check the trailing window (most recent N).
        let window_start = relevant.len().saturating_sub(self.promotion_window);
        let window = &relevant[window_start..];

        for (i, obs) in window.iter().enumerate() {
            if obs.token_parity < self.promotion_threshold {
                return Err(format!(
                    "promotion failed: observation {} token_parity {:.4} < threshold {:.2}",
                    i, obs.token_parity, self.promotion_threshold
                ));
            }
            if obs.device_activity < self.min_device_activity {
                return Err(format!(
                    "promotion failed: observation {} device_activity {:.4} < min {:.2}",
                    i, obs.device_activity, self.min_device_activity
                ));
            }
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    /// Serialize a slice of evidence as pretty-printed JSON and write to
    /// `path`.
    pub fn write_evidence(
        evidence: &[ProfileEvidence],
        path: &Path,
    ) -> napi::Result<()> {
        let json = serde_json::to_string_pretty(evidence).map_err(|e| {
            napi::Error::from_reason(format!("failed to serialize evidence: {}", e))
        })?;
        std::fs::write(path, &json).map_err(|e| {
            napi::Error::from_reason(format!(
                "failed to write evidence to {}: {}",
                path.display(),
                e
            ))
        })?;
        Ok(())
    }

    /// Read and deserialize evidence from a JSON file at `path`.
    ///
    /// Returns an empty `Vec` when the file does not exist (first-use
    /// convention).  Propagates other I/O and parse errors.
    pub fn read_evidence(path: &Path) -> napi::Result<Vec<ProfileEvidence>> {
        if !path.exists() {
            return Ok(Vec::new());
        }

        let json = std::fs::read_to_string(path).map_err(|e| {
            napi::Error::from_reason(format!(
                "failed to read evidence from {}: {}",
                path.display(),
                e
            ))
        })?;

        serde_json::from_str(&json).map_err(|e| {
            napi::Error::from_reason(format!(
                "failed to parse evidence from {}: {}",
                path.display(),
                e
            ))
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_evidence(profile_id: &str, parity: f64, activity: f64) -> ProfileEvidence {
        ProfileEvidence::new(
            profile_id.into(),
            100.0,
            100.0 * parity,
            5.0,
            activity,
        )
    }

    #[test]
    fn test_evidence_new_computes_parity() {
        let ev = ProfileEvidence::new("p1".into(), 200.0, 180.0, 0.0, 0.8);
        assert!((ev.token_parity - 0.9).abs() < 1e-9);
        assert!(!ev.is_meeting_oracle());
    }

    #[test]
    fn test_evidence_at_parity() {
        let ev = ProfileEvidence::new("p1".into(), 200.0, 200.0, 0.0, 0.8);
        assert!((ev.token_parity - 1.0).abs() < 1e-9);
        assert!(ev.is_meeting_oracle());
        assert!(!ev.is_degraded());
    }

    #[test]
    fn test_evidence_above_parity() {
        let ev = ProfileEvidence::new("p1".into(), 200.0, 250.0, 0.0, 0.8);
        assert!((ev.token_parity - 1.25).abs() < 1e-9);
        assert!(ev.is_meeting_oracle());
    }

    #[test]
    fn test_evidence_degraded() {
        let ev = ProfileEvidence::new("p1".into(), 200.0, 150.0, 0.0, 0.8);
        assert!((ev.token_parity - 0.75).abs() < 1e-9);
        assert!(ev.is_degraded());
    }

    #[test]
    fn test_evidence_zero_oracle() {
        let ev = ProfileEvidence::new("p1".into(), 0.0, 100.0, 0.0, 0.8);
        assert!((ev.token_parity - 0.0).abs() < 1e-9);
        assert!(ev.is_degraded());
    }

    #[test]
    fn test_evidence_device_activity_clamp() {
        let ev = ProfileEvidence::new("p1".into(), 100.0, 100.0, 0.0, 1.5);
        assert!((ev.device_activity - 1.0).abs() < 1e-9);
        let ev2 = ProfileEvidence::new("p1".into(), 100.0, 100.0, 0.0, -0.5);
        assert!((ev2.device_activity - 0.0).abs() < 1e-9);
    }

    #[test]
    fn test_collect_evidence_via_requalifier() {
        let r = Requalifier::default();
        let ev = r.collect_evidence("p1".into(), 200.0, 210.0, 3.0, 0.9);
        assert_eq!(ev.profile_id, "p1");
        assert!((ev.token_parity - 1.05).abs() < 1e-9);
        assert!((ev.boundary_latency_us - 3.0).abs() < 1e-9);
    }

    #[test]
    fn test_promote_to_preferred_success() {
        let r = Requalifier::new(3, 1.0, 0.5);
        let ev: Vec<ProfileEvidence> = (0..5)
            .map(|_| sample_evidence("p1", 1.05, 0.8))
            .collect();
        assert!(r.promote_to_preferred(&ev, "p1").is_ok());
    }

    #[test]
    fn test_promote_to_preferred_empty() {
        let r = Requalifier::default();
        let result = r.promote_to_preferred(&[], "p1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no evidence"));
    }

    #[test]
    fn test_promote_to_preferred_insufficient() {
        let r = Requalifier::new(5, 1.0, 0.5);
        let ev: Vec<ProfileEvidence> = (0..2)
            .map(|_| sample_evidence("p1", 1.05, 0.8))
            .collect();
        let result = r.promote_to_preferred(&ev, "p1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("need 5 observations"));
    }

    #[test]
    fn test_promote_to_preferred_filters_by_profile() {
        let r = Requalifier::new(2, 1.0, 0.5);
        let mut ev: Vec<ProfileEvidence> = (0..3)
            .map(|_| sample_evidence("p1", 1.05, 0.8))
            .collect();
        // Add evidence for a different profile — should not affect p1.
        ev.push(sample_evidence("p2", 0.5, 0.1));
        assert!(r.promote_to_preferred(&ev, "p1").is_ok());
    }

    #[test]
    fn test_promote_to_preferred_low_parity() {
        let r = Requalifier::new(2, 1.0, 0.5);
        let ev: Vec<ProfileEvidence> = (0..2)
            .map(|_| sample_evidence("p1", 0.9, 0.8))
            .collect();
        let result = r.promote_to_preferred(&ev, "p1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("token_parity"));
    }

    #[test]
    fn test_promote_to_preferred_low_activity() {
        let r = Requalifier::new(2, 1.0, 0.7);
        let ev: Vec<ProfileEvidence> = (0..2)
            .map(|_| sample_evidence("p1", 1.05, 0.3))
            .collect();
        let result = r.promote_to_preferred(&ev, "p1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("device_activity"));
    }

    #[test]
    fn test_write_read_evidence_roundtrip() {
        let ev: Vec<ProfileEvidence> = (0..3)
            .map(|i| {
                ProfileEvidence::new(
                    format!("p{}", i),
                    100.0,
                    100.0 + i as f64 * 10.0,
                    5.0,
                    0.8,
                )
            })
            .collect();

        let tmp = std::env::temp_dir().join("test_evidence.json");
        Requalifier::write_evidence(&ev, &tmp).expect("write should succeed");
        let read = Requalifier::read_evidence(&tmp).expect("read should succeed");
        assert_eq!(read.len(), 3);
        assert_eq!(read[0].profile_id, "p0");
        assert_eq!(read[1].profile_id, "p1");
        assert_eq!(read[2].profile_id, "p2");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_read_evidence_missing_file() {
        let tmp = PathBuf::from("/tmp/nonexistent_evidence_XXXX.json");
        let read = Requalifier::read_evidence(&tmp).expect("missing file should return empty");
        assert!(read.is_empty());
    }

    #[test]
    fn test_serde_roundtrip() {
        let ev = ProfileEvidence::new("p1".into(), 200.0, 210.0, 3.0, 0.9);
        let json = serde_json::to_string(&ev).expect("serialize");
        let parsed: ProfileEvidence = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.profile_id, "p1");
        assert!((parsed.token_parity - 1.05).abs() < 1e-9);
    }

    #[test]
    fn test_default_requalifier_params() {
        let r = Requalifier::default();
        assert_eq!(r.promotion_window, 3);
        assert!((r.promotion_threshold - 1.0).abs() < 1e-9);
        assert!((r.min_device_activity - 0.5).abs() < 1e-9);
    }
}
