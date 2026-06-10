//! ComputeService — async, Send-safe, Tokio-native model/session interface.
//!
//! This is the outer-plane contract.  Implementations translate async
//! calls into ComputeLane commands.

use crate::compute_lane::*;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

/// Async, Send-safe compute service.
///
/// Every method returns a Result with a receipt or an error.  The
/// implementation sends a ComputeCommand to a device lane and awaits
/// the oneshot reply.
#[async_trait::async_trait]
pub trait ComputeService: Send + Sync {
    async fn load_model(
        &self,
        request_id: RequestId,
        model: ComputeImageDescriptor,
    ) -> Result<ModelRuntimeReceipt, ComputeError>;

    async fn open_session(
        &self,
        request_id: RequestId,
        model_id: ModelRuntimeId,
        policy: SessionPolicy,
    ) -> Result<SessionReceipt, ComputeError>;

    async fn prefill(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        tokens: Arc<[u32]>,
    ) -> Result<PrefillReceipt, ComputeError>;

    async fn decode(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        budget: u32,
        event_tx: tokio::sync::mpsc::Sender<DecodeEvent>,
    ) -> Result<(), ComputeError>;

    async fn cancel(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        reason: CancellationReason,
    ) -> Result<(), ComputeError>;

    async fn close_session(
        &self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> Result<CloseReceipt, ComputeError>;

    async fn unload_model(
        &self,
        request_id: RequestId,
        model_id: ModelRuntimeId,
    ) -> Result<UnloadReceipt, ComputeError>;

    async fn shutdown(&self, reason: ShutdownReason) -> Result<(), ComputeError>;
}

/// Lane-backed implementation of ComputeService.
pub struct ComputeServiceClient {
    lane: std::sync::Arc<LaneHandle>,
}

impl ComputeServiceClient {
    pub fn new(lane: LaneHandle) -> Self {
        Self { lane: lane.into() }
    }
}

#[async_trait::async_trait]
impl ComputeService for ComputeServiceClient {
    async fn load_model(
        &self,
        request_id: RequestId,
        model: ComputeImageDescriptor,
    ) -> Result<ModelRuntimeReceipt, ComputeError> {
        let (tx, rx) = oneshot::channel();
        self.lane
            .send(ComputeCommand::LoadModel { request_id, model, reply: tx })
            .await?;
        rx.await.unwrap_or_else(|_| Err(ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "load_model: lane dropped reply sender".into(),
        }))
    }

    async fn open_session(
        &self,
        request_id: RequestId,
        model_id: ModelRuntimeId,
        session_policy: SessionPolicy,
    ) -> Result<SessionReceipt, ComputeError> {
        let (tx, rx) = oneshot::channel();
        self.lane
            .send(ComputeCommand::OpenSession {
                request_id,
                model_id,
                session_policy,
                reply: tx,
            })
            .await?;
        rx.await.unwrap_or_else(|_| Err(ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "open_session: lane dropped reply sender".into(),
        }))
    }

    async fn prefill(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        tokens: Arc<[u32]>,
    ) -> Result<PrefillReceipt, ComputeError> {
        let (tx, rx) = oneshot::channel();
        self.lane
            .send(ComputeCommand::Prefill {
                request_id,
                session_id,
                tokens,
                reply: tx,
            })
            .await?;
        rx.await.unwrap_or_else(|_| Err(ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "prefill: lane dropped reply sender".into(),
        }))
    }

    async fn decode(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        budget: u32,
        event_tx: tokio::sync::mpsc::Sender<DecodeEvent>,
    ) -> Result<(), ComputeError> {
        // For decode, the lane sends events through event_tx directly.
        // The lane does NOT send a final oneshot — it sends DecodeEvent values
        // and then drops event_tx.  The caller reads event_tx until it closes.
        self.lane
            .send(ComputeCommand::Decode {
                request_id,
                session_id,
                budget,
                reply: event_tx,
            })
            .await
    }

    async fn cancel(
        &self,
        request_id: RequestId,
        session_id: SessionId,
        reason: CancellationReason,
    ) -> Result<(), ComputeError> {
        // Cancel is fire-and-forget — no reply channel on the command variant.
        self.lane
            .send(ComputeCommand::Cancel {
                request_id,
                session_id,
                reason,
            })
            .await
    }

    async fn close_session(
        &self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> Result<CloseReceipt, ComputeError> {
        let (tx, rx) = oneshot::channel();
        self.lane
            .send(ComputeCommand::CloseSession {
                request_id,
                session_id,
                reply: tx,
            })
            .await?;
        rx.await.unwrap_or_else(|_| Err(ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "close_session: lane dropped reply sender".into(),
        }))
    }

    async fn unload_model(
        &self,
        request_id: RequestId,
        model_id: ModelRuntimeId,
    ) -> Result<UnloadReceipt, ComputeError> {
        let (tx, rx) = oneshot::channel();
        self.lane
            .send(ComputeCommand::UnloadModel {
                request_id,
                model_id,
                reply: tx,
            })
            .await?;
        rx.await.unwrap_or_else(|_| Err(ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "unload_model: lane dropped reply sender".into(),
        }))
    }

    async fn shutdown(&self, reason: ShutdownReason) -> Result<(), ComputeError> {
        self.lane
            .send(ComputeCommand::Shutdown { reason })
            .await
    }
}
