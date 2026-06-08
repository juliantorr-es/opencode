//! Event-driven generation streaming infrastructure.
//!
//! Provides a bounded channel pair for streaming generation events
//! (tokens, text chunks, progress, metrics, warnings, errors, lifecycle)
//! from a compute-native generation backend to a JS consumer.
//!
//! # Structure
//!
//! - [`GenerationEvent`] — all event variants emitted during a generation run.
//! - [`GenerationSender`] — the production half; call sites push events.
//! - [`GenerationStream`] — the consumption half; JS calls `recv`/`try_recv`.
//! - [`generation_channel`] — construct a (sender, stream) pair.

use napi_derive::napi;

/// Events emitted during a single generation run.
///
/// Every run begins with `Started` and ends with `Done`, `Error(String)`,
/// or a terminal variant. Between bookends the stream emits zero or more
/// `Token`, `Chunk`, `Progress`, `Speed`, or `Warning` events.
#[derive(Clone, Debug)]
#[napi]
pub enum GenerationEvent {
    /// Generation has started — the model is beginning its forward pass.
    Started,
    /// A single raw token ID from the model output.
    Token(u32),
    /// A decoded text segment ready for display or streaming.
    Chunk(String),
    /// A batch of logits from the model head (useful for custom samplers).
    Logits(Vec<f64>),
    /// Overall generation progress as a fraction in `[0.0, 1.0]`.
    Progress(f64),
    /// Performance metrics payload (e.g. JSON blob with tokens/s, TTFT).
    Metrics(String),
    /// Non-fatal warning message.
    Warning(String),
    /// Fatal error — generation terminated abnormally.
    Error(String),
    /// Generation completed normally — no more events will follow.
    Done,
}

/// The receiving half of a generation event channel.
///
/// JS consumers call [`recv`](Self::recv) to block for the next event,
/// [`try_recv`](Self::try_recv) to poll without blocking, or
/// [`close`](Self::close) to signal that no more events are wanted.
#[napi]
pub struct GenerationStream {
    inner: tokio::sync::mpsc::Receiver<GenerationEvent>,
}

#[napi]
impl GenerationStream {
    /// Block the current thread until the next event arrives or the channel
    /// is closed and drained.
    #[napi]
    pub fn recv(&mut self) -> Option<GenerationEvent> {
        self.inner.blocking_recv()
    }

    /// Attempt to receive an event without blocking.
    ///
    /// Returns `None` when the channel is empty but still open, or closed
    /// and drained.
    #[napi]
    pub fn try_recv(&mut self) -> Option<GenerationEvent> {
        self.inner.try_recv().ok()
    }

    /// Close the channel — the sender will see `is_closed() == true` and
    /// subsequent sends will fail.
    #[napi]
    pub fn close(&mut self) {
        self.inner.close();
    }
}

/// The sending half of a generation event channel.
///
/// Generation backends obtain a sender from [`generation_channel`] and call
/// [`try_send`](Self::try_send) or [`blocking_send`](Self::blocking_send) to
/// push events to the consumer.
#[napi]
pub struct GenerationSender {
    inner: tokio::sync::mpsc::Sender<GenerationEvent>,
}

#[napi]
impl GenerationSender {
    /// Try to send an event without blocking.
    ///
    /// Returns an error when the channel is full (the caller should retry
    /// after the consumer drains) or closed (the consumer dropped the stream).
    #[napi]
    pub fn try_send(&self, event: GenerationEvent) -> napi::Result<()> {
        use tokio::sync::mpsc::error::TrySendError;
        self.inner.try_send(event).map_err(|e| {
            let msg: String = match &e {
                TrySendError::Full(_) => "channel full".into(),
                TrySendError::Closed(_) => "channel closed".into(),
            };
            napi::Error::from_reason(msg)
        })
    }

    /// Block the current thread until the event is sent.
    ///
    /// Fails when the consumer has dropped the stream.
    #[napi]
    pub fn blocking_send(&self, event: GenerationEvent) -> napi::Result<()> {
        self.inner
            .blocking_send(event)
            .map_err(|_| napi::Error::from_reason("channel closed"))
    }

    /// Check whether the consumer has dropped the stream.
    #[napi]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Maximum capacity the channel was created with.
    #[napi]
    pub fn capacity(&self) -> usize {
        self.inner.max_capacity()
    }
}

/// Create a new bounded generation channel, returning the producer
/// ([`GenerationSender`]) and consumer ([`GenerationStream`]) pair.
///
/// `capacity` controls the maximum number of buffered events before
/// [`try_send`](GenerationSender::try_send) returns an error. Defaults to 128.
///
/// # Example (TypeScript)
///
/// ```ts
/// const [sender, stream] = generationChannel(256);
/// // sender.send(...)  — from the backend
/// // stream.recv()      — from the consumer
/// ```
#[napi]
pub fn generation_channel(
    capacity: Option<u32>,
) -> (GenerationSender, GenerationStream) {
    let cap = capacity.unwrap_or(128).max(1) as usize;
    let (tx, rx) = tokio::sync::mpsc::channel(cap);
    (GenerationSender { inner: tx }, GenerationStream { inner: rx })
}
