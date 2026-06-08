//! Event-driven generation streaming infrastructure.
//!
//! Provides a bounded channel pair for streaming generation events
//! (tokens, text chunks, progress, metrics, warnings, errors, lifecycle)
//! from a compute-native generation backend to a JS consumer, plus an
//! unbounded out-of-band channel for terminal events so they always
//! deliver even when the main event buffer is saturated.
//!
//! # Structure
//!
//! - [`GenerationEvent`] — all event variants emitted during a generation run.
//! - [`GenerationSender`] — the production half; call sites push events.
//! - [`GenerationStream`] — the consumption half; JS calls `recv`/`try_recv`.
//! - [`generation_channel`] — construct a (sender, stream) pair.
//! - [`validate_event_sequence`] — check a slice of events for valid ordering.
use napi_derive::napi;
use std::fmt;

/// Events emitted during a single generation run.
///
/// Every run begins with `Started` and ends with `Done`, `Error(String)`,
/// `Cancelled`, or another terminal variant. Between bookends the stream
/// emits zero or more `Token`, `Chunk`, `Progress`, `Speed`, or `Warning`
/// events.
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
    /// Generation was cancelled by the consumer — no more events.
    Cancelled,
}

// ---------------------------------------------------------------------------
// Terminal-event helpers
// ---------------------------------------------------------------------------

/// Returns `true` when `event` is a terminal variant (Done, Error, Cancelled).
#[allow(dead_code)]
fn is_terminal(event: &GenerationEvent) -> bool {
    matches!(event, GenerationEvent::Done | GenerationEvent::Error(_) | GenerationEvent::Cancelled)
}

// ---------------------------------------------------------------------------
// Receiving half
// ---------------------------------------------------------------------------

/// The receiving half of a generation event channel.
///
/// JS consumers call [`recv`](Self::recv) to block for the next event,
/// [`try_recv`](Self::try_recv) to poll without blocking, or
/// [`close`](Self::close) to signal that no more events are wanted.
///
/// Terminal events (Done, Error, Cancelled) are delivered through a
/// separate unbounded channel so they always arrive even when the
/// main event buffer is saturated.
#[napi]
pub struct GenerationStream {
    inner: tokio::sync::mpsc::Receiver<GenerationEvent>,
    terminal_rx: tokio::sync::mpsc::UnboundedReceiver<GenerationEvent>,
    closed: bool,
    /// Oneshot sender — fired when the stream is closed.
    /// Extracted at channel creation; the receiver side is returned by
    /// [`take_disconnect_notifier`].
    disconnect_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// Oneshot receiver — taken by callers who want to await disconnect.
    disconnect_rx: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl fmt::Debug for GenerationStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GenerationStream")
            .field("closed", &self.closed)
            .field("disconnect_tx", &self.disconnect_tx.as_ref().map(|_| "<Sender>"))
            .field("disconnect_rx", &self.disconnect_rx.as_ref().map(|_| "<Receiver>"))
            .finish_non_exhaustive()
    }
}

#[napi]
impl GenerationStream {
    /// Block the current thread until the next event arrives or the channel
    /// is closed and drained.
    ///
    /// Ordinary events are drained first to preserve ordering. Terminal
    /// events are only returned when the ordinary channel is empty.
    #[napi]
    pub fn recv(&mut self) -> Option<GenerationEvent> {
        // Drain ordinary channel first — preserve ordering.
        if let Ok(event) = self.inner.try_recv() {
            return Some(event);
        }
        // Only check terminal when ordinary is drained.
        if let Ok(event) = self.terminal_rx.try_recv() {
            return Some(event);
        }
        // Block only on ordinary channel.
        self.inner.blocking_recv()
    }

    /// Attempt to receive an event without blocking.
    ///
    /// Ordinary events are checked first to preserve ordering.
    ///
    /// Returns `None` when the channel is empty but still open, or closed
    /// and drained.
    #[napi]
    pub fn try_recv(&mut self) -> Option<GenerationEvent> {
        // Drain ordinary channel first — preserve ordering.
        if let Ok(event) = self.inner.try_recv() {
            return Some(event);
        }
        self.terminal_rx.try_recv().ok()
    }

    /// Close the stream — signals the sender via `is_closed()` that the
    /// consumer has disconnected. Subsequent `try_send_or_cancel` calls
    /// on the sender return `Cancelled`.
    ///
    /// The unbounded terminal channel is **not** closed so that any
    /// already-in-flight terminal event can still be delivered.
    #[napi]
    pub fn close(&mut self) {
        self.inner.close();
        // Fire the disconnect oneshot so any waiting receiver is woken.
        if let Some(tx) = self.disconnect_tx.take() {
            let _ = tx.send(());
        }
        self.closed = true;
    }

    /// Returns `true` once [`close`](Self::close) has been called.
    #[napi]
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Extract the disconnect notifier receiver, if it hasn't been taken
    /// already.
    ///
    /// The returned [`Receiver`](tokio::sync::oneshot::Receiver) resolves
    /// (with `Ok(())` or `Err(oneshot::error::RecvError)`) when the stream
    /// is closed. Callers can `.await` or `.blocking_recv()` on it to
    /// detect consumer disconnect without polling.
    pub fn take_disconnect_notifier(
        &mut self,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.disconnect_rx.take()
    }
}

// ---------------------------------------------------------------------------
// Sending half
// ---------------------------------------------------------------------------

/// The sending half of a generation event channel.
///
/// Generation backends obtain a sender from [`generation_channel`] and call
/// [`try_send`](Self::try_send), [`blocking_send`](Self::blocking_send), or
/// [`send_terminal`](Self::send_terminal) to push events to the consumer.
///
/// Terminal events (Done, Error, Cancelled) sent via [`send_terminal`] use
/// a separate unbounded channel and are therefore guaranteed to arrive even
/// when the main event buffer is full.
#[napi]
pub struct GenerationSender {
    inner: tokio::sync::mpsc::Sender<GenerationEvent>,
    terminal_tx: tokio::sync::mpsc::UnboundedSender<GenerationEvent>,
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

    /// Send a terminal event through the out-of-band unbounded channel.
    ///
    /// This always succeeds — the event will be delivered even if the
    /// main bounded channel is completely full. If the consumer has
    /// already dropped the stream, the event is silently discarded.
    #[napi]
    pub fn send_terminal(&self, event: GenerationEvent) {
        // Silently discard if the consumer is already gone — the stream
        // has been dropped and nobody is listening.
        let _ = self.terminal_tx.send(event);
    }

    /// Attempt to send, returning an immediate `"Cancelled"` error when
    /// the consumer has closed the stream.
    ///
    /// This is the preferred method for backends that want to avoid
    /// unnecessary work once the consumer has disconnected.
    #[napi]
    pub fn try_send_or_cancel(&self, event: GenerationEvent) -> napi::Result<()> {
        if self.inner.is_closed() {
            return Err(napi::Error::from_reason("Cancelled"));
        }
        use tokio::sync::mpsc::error::TrySendError;
        self.inner.try_send(event).map_err(|e| {
            let msg: String = match &e {
                TrySendError::Full(_) => "channel full".into(),
                TrySendError::Closed(_) => "channel closed".into(),
            };
            napi::Error::from_reason(msg)
        })
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

    /// Returns `true` when the consumer has disconnected from the stream
    /// (either the main event channel is closed OR the terminal channel
    /// is closed).
    ///
    /// Backends should check this before performing expensive work.
    pub fn is_disconnected(&self) -> bool {
        self.inner.is_closed() || self.terminal_tx.is_closed()
    }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

/// Create a new bounded generation channel, returning the producer
/// ([`GenerationSender`]) and consumer ([`GenerationStream`]) pair.
///
/// `capacity` controls the maximum number of buffered events before
/// [`try_send`](GenerationSender::try_send) returns an error. Defaults to 128.
///
/// Terminal events sent via [`send_terminal`](GenerationSender::send_terminal)
/// use a separate unbounded channel and are unaffected by this limit.
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
    let (terminal_tx, terminal_rx) = tokio::sync::mpsc::unbounded_channel();
    let (disconnect_tx, disconnect_rx) = tokio::sync::oneshot::channel();
    (
        GenerationSender {
            inner: tx,
            terminal_tx,
        },
        GenerationStream {
            inner: rx,
            terminal_rx,
            disconnect_tx: Some(disconnect_tx),
            disconnect_rx: Some(disconnect_rx),
            closed: false,
        },
    )
}

// ---------------------------------------------------------------------------
// Event ordering validation
// ---------------------------------------------------------------------------

/// Validate that a slice of events follows correct generation ordering rules:
///
/// 1. `Started` comes first **if present** — no events may precede it.
/// 2. Tokens and streaming events occur only during *active* generation
///    (after `Started`, before a terminal event).
/// 3. **Exactly one** terminal event exists (`Done`, `Error`, or `Cancelled`).
/// 4. No events appear after the terminal event.
///
/// Returns `true` when the sequence satisfies all rules.
#[napi]
pub fn validate_event_sequence(events: Vec<GenerationEvent>) -> bool {
    validate_event_sequence_impl(&events)
}

/// Internal implementation — same logic, works on a borrowed slice.
fn validate_event_sequence_impl(events: &[GenerationEvent]) -> bool {
    let mut terminal_count: usize = 0;
    let mut active: bool = false; // true between Started and terminal
    let mut started_seen: bool = false;

    for (i, event) in events.iter().enumerate() {
        match event {
            GenerationEvent::Started => {
                if started_seen {
                    return false; // duplicate Started
                }
                if i != 0 {
                    return false; // Started must be first if present
                }
                started_seen = true;
                active = true;
            }

            // Streaming payload events — valid only during active generation.
            GenerationEvent::Token(_)
            | GenerationEvent::Chunk(_)
            | GenerationEvent::Logits(_)
            | GenerationEvent::Progress(_)
            | GenerationEvent::Metrics(_)
            | GenerationEvent::Warning(_) => {
                if !active {
                    return false; // event outside active generation window
                }
            }

            // Terminal events.
            GenerationEvent::Done | GenerationEvent::Error(_) | GenerationEvent::Cancelled => {
                terminal_count += 1;
                if terminal_count > 1 {
                    return false; // at most one terminal event
                }
                active = false; // no more payload events allowed after this
            }
        }
    }

    // A valid *complete* sequence must have exactly one terminal event.
    terminal_count == 1
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// A stable handle wrapping a [`GenerationStream`] with a unique job ID.
///
/// This is pure Rust (not napi-exported) and is intended to be embedded
/// in higher-level N-API wrappers (e.g. in `engine.rs`).
#[derive(Debug)]
pub struct GenerationHandle {
    pub job_id: String,
    pub stream: GenerationStream,
}

impl GenerationHandle {
    /// Create a new `GenerationHandle` with the given job ID.
    pub fn new(job_id: String, stream: GenerationStream) -> Self {
        Self { job_id, stream }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Basic round-trip through the bounded channel.
    #[test]
    fn test_basic_send_recv() {
        let (tx, mut rx) = generation_channel(None);

        tx.try_send(GenerationEvent::Started).unwrap();
        tx.try_send(GenerationEvent::Token(42)).unwrap();
        tx.try_send(GenerationEvent::Chunk("hello".into())).unwrap();
        tx.send_terminal(GenerationEvent::Done);

        assert!(matches!(rx.recv(), Some(GenerationEvent::Started)));
        assert!(matches!(rx.recv(), Some(GenerationEvent::Token(42))));
        assert!(matches!(rx.recv(), Some(GenerationEvent::Chunk(s)) if s == "hello"));
        assert!(matches!(rx.recv(), Some(GenerationEvent::Done)));
        assert!(rx.recv().is_none()); // drained
    }

    /// Terminal events are delivered even when the bounded channel is
    /// saturated (capacity 1, full, then send_terminal).
    #[test]
    fn test_terminal_delivery_under_pressure() {
        let (tx, mut rx) = generation_channel(Some(1));

        // Fill the bounded channel.
        tx.try_send(GenerationEvent::Token(1)).unwrap();
        assert!(tx.try_send(GenerationEvent::Token(2)).is_err()); // full

        // Terminal still gets through.
        tx.send_terminal(GenerationEvent::Done);

        assert!(matches!(rx.recv(), Some(GenerationEvent::Token(1))));
        assert!(matches!(rx.recv(), Some(GenerationEvent::Done)));
        assert!(rx.recv().is_none()); // drained
    }

    /// Sender sees closure when the stream is closed.
    #[test]
    fn test_consumer_disconnect_cancels() {
        let (tx, mut rx) = generation_channel(None);

        assert!(!tx.is_closed());

        // Consumer closes the stream.
        rx.close();
        assert!(rx.is_closed());

        // Sender observes closure.
        assert!(tx.is_closed());

        // try_send_or_cancel returns Cancelled.
        let result = tx.try_send_or_cancel(GenerationEvent::Token(99));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().reason, "Cancelled");
    }

    /// try_send_or_cancel succeeds when the stream is open.
    #[test]
    fn test_try_send_or_cancel_open() {
        let (tx, _rx) = generation_channel(None);
        let result = tx.try_send_or_cancel(GenerationEvent::Token(1));
        assert!(result.is_ok());
    }

    /// Terminal events via the unbounded channel are received even after
    /// the bounded channel is closed by the consumer.
    #[test]
    fn test_terminal_after_close() {
        let (tx, mut rx) = generation_channel(None);

        // Consumer closes.
        rx.close();

        // Terminal still arrives.
        tx.send_terminal(GenerationEvent::Cancelled);

        assert!(matches!(rx.recv(), Some(GenerationEvent::Cancelled)));
    }

    // ------------------------------------------------------------------
    // validate_event_sequence
    // ------------------------------------------------------------------

    #[test]
    fn test_sequence_valid_complete() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Token(1),
            GenerationEvent::Chunk("a".into()),
            GenerationEvent::Done,
        ];
        assert!(validate_event_sequence(events));
    }

    #[test]
    fn test_sequence_no_started_rejects_tokens() {
        // Started is optional per spec ("if present").
        let events = vec![
            GenerationEvent::Token(42),
            GenerationEvent::Done,
        ];
        // Without Started, active=false, so Token is rejected.
        assert!(!validate_event_sequence_impl(&events));
    }

    #[test]
    fn test_sequence_started_not_first() {
        let events = vec![
            GenerationEvent::Token(1),
            GenerationEvent::Started,
            GenerationEvent::Done,
        ];
        assert!(!validate_event_sequence_impl(&events));
    }
    #[test]
    fn test_sequence_duplicate_terminal() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Done,
            GenerationEvent::Cancelled,
        ];
        assert!(!validate_event_sequence_impl(&events));
    }

    #[test]
    fn test_sequence_events_after_terminal() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Done,
            GenerationEvent::Token(99),
        ];
        assert!(!validate_event_sequence_impl(&events));
    }

    #[test]
    fn test_sequence_token_before_started() {
        let events = vec![
            GenerationEvent::Token(1),
            GenerationEvent::Started,
            GenerationEvent::Done,
        ];
        assert!(!validate_event_sequence_impl(&events));
    }

    #[test]
    fn test_sequence_missing_terminal() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Token(42),
        ];
        assert!(!validate_event_sequence_impl(&events));
    }

    #[test]
    fn test_sequence_only_terminal_is_valid() {
        let events = vec![GenerationEvent::Error("oops".into())];
        assert!(validate_event_sequence_impl(&events));
    }

    /// Full valid scenario with every variant.
    #[test]
    fn test_sequence_full_lifecycle() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Token(1),
            GenerationEvent::Chunk("Hello".into()),
            GenerationEvent::Logits(vec![0.1, 0.9]),
            GenerationEvent::Progress(0.5),
            GenerationEvent::Metrics("{\"tokens/s\": 42}".into()),
            GenerationEvent::Warning("nearing context limit".into()),
            GenerationEvent::Error("out of memory".into()),
        ];
        assert!(validate_event_sequence_impl(&events));
    }

    /// Terminal events outside the bounded channel still pass validation.
    #[test]
    fn test_event_sequence_validation() {
        // Valid: Started, tokens, terminal
        assert!(validate_event_sequence_impl(&[
            GenerationEvent::Started,
            GenerationEvent::Token(1),
            GenerationEvent::Done,
        ]));

        // Valid: only terminal
        assert!(validate_event_sequence_impl(&[
            GenerationEvent::Cancelled,
        ]));

        // Invalid: token before Started
        assert!(!validate_event_sequence_impl(&[
            GenerationEvent::Token(1),
            GenerationEvent::Started,
            GenerationEvent::Done,
        ]));

        // Invalid: duplicate terminal
        assert!(!validate_event_sequence_impl(&[
            GenerationEvent::Done,
            GenerationEvent::Done,
        ]));

        // Invalid: events after terminal
        assert!(!validate_event_sequence_impl(&[
            GenerationEvent::Started,
            GenerationEvent::Done,
            GenerationEvent::Token(2),
        ]));

        // Invalid: no terminal
        assert!(!validate_event_sequence_impl(&[
            GenerationEvent::Started,
            GenerationEvent::Token(1),
        ]));
    }

    /// Terminal events outside the bounded channel still pass validation.
    #[test]
    fn test_sequence_cancelled_terminal() {
        let events = vec![
            GenerationEvent::Started,
            GenerationEvent::Token(1),
            GenerationEvent::Cancelled,
        ];
        assert!(validate_event_sequence_impl(&events));
    }

    // ------------------------------------------------------------------
    // End-to-end concurrent tests
    // ------------------------------------------------------------------

    /// Spawn a task that sends a terminal event while the consumer reads
    /// from a nearly-full channel.
    #[test]
    fn test_concurrent_terminal_delivery() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let (tx, mut rx) = generation_channel(Some(2));

        // Pre-fill.
        tx.try_send(GenerationEvent::Token(1)).unwrap();
        tx.try_send(GenerationEvent::Token(2)).unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let done_clone = done.clone();

        // In another thread, send a terminal once the main thread starts reading.
        std::thread::spawn(move || {
            while !done_clone.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            tx.send_terminal(GenerationEvent::Done);
        });

        // Drain.
        assert!(matches!(rx.recv(), Some(GenerationEvent::Token(1))));
        assert!(matches!(rx.recv(), Some(GenerationEvent::Token(2))));
        // At this point the bounded channel is empty, so the terminal
        // from the other thread should arrive.
        done.store(true, Ordering::SeqCst);
        assert!(matches!(rx.recv(), Some(GenerationEvent::Done)));
        assert!(rx.recv().is_none());
    }

    // ------------------------------------------------------------------
    // GenerationHandle & disconnect notifier
    // ------------------------------------------------------------------

    #[test]
    fn test_generation_handle_job_id() {
        let (_, stream) = generation_channel(None);
        let handle = GenerationHandle::new("job-42".to_string(), stream);

        assert_eq!(handle.job_id, "job-42");
    }

    #[test]
    fn test_disconnect_notifier_fires_on_close() {
        let (_, mut stream) = generation_channel(None);
        let mut rx = stream
            .take_disconnect_notifier()
            .expect("disconnect rx should be present");

        // Not yet closed.
        assert!(!stream.is_closed());

        // Close the stream — this should fire the oneshot.
        stream.close();

        // The receiver should now resolve.
        match rx.try_recv() {
            Ok(()) => {} // expected
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                panic!("disconnect notifier was dropped before send");
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                panic!("disconnect notifier not fired after close");
            }
        }
    }
}
