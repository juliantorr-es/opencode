//! Event-driven generation streaming infrastructure.
//!
//! Provides a single unified event queue backed by `parking_lot::Mutex` +
//! `Condvar` for streaming generation events from a compute-native generation
//! backend to a JS consumer.
//!
//! Terminal events bypass the capacity check so they always deliver even when
//! the event buffer is saturated, and the single-queue design eliminates the
//! wake-up race present in the old dual-channel approach.
//!
//! # Structure
//!
//! - [`GenerationEvent`] — all event variants emitted during a generation run.
//! - [`GenerationSender`] — the production half; call sites push events.
//! - [`GenerationStream`] — the consumption half; JS calls `recv`/`try_recv`.
//! - [`generation_channel`] — construct a (sender, stream) pair.
//! - [`validate_event_sequence`] — check a slice of events for valid ordering.
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
// Internal shared queue
// ---------------------------------------------------------------------------

/// The shared state behind both [`GenerationSender`] and [`GenerationStream`].
///
/// All events — ordinary and terminal — go through the same `VecDeque`,
/// protected by a `parking_lot::Mutex` and signaled with a `Condvar`. The
/// [`closed`] flag is set when the consumer calls [`GenerationStream::close`];
/// `sender_alive` tracks whether any sender is still alive (so the consumer
/// can distinguish "nothing right now" from "nothing ever again").
struct SharedQueue {
    queue: Mutex<VecDeque<GenerationEvent>>,
    cv: Condvar,
    capacity: usize,
    closed: AtomicBool,
    sender_alive: AtomicBool,
    terminal_seen: AtomicBool,
}

impl SharedQueue {
    fn new(capacity: usize) -> Self {
        Self {
            queue: Mutex::new(VecDeque::with_capacity(capacity)),
            cv: Condvar::new(),
            capacity,
            closed: AtomicBool::new(false),
            sender_alive: AtomicBool::new(true),
            terminal_seen: AtomicBool::new(false),
        }
    }
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
/// All events flow through a single unified queue so there is no wake-up race
/// between ordinary and terminal events.
#[napi]
pub struct GenerationStream {
    shared: Arc<SharedQueue>,
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
            .field("closed", &self.shared.closed.load(Ordering::Relaxed))
            .field("disconnect_tx", &self.disconnect_tx.as_ref().map(|_| "<Sender>"))
            .field("disconnect_rx", &self.disconnect_rx.as_ref().map(|_| "<Receiver>"))
            .finish_non_exhaustive()
    }
}

#[napi]
impl GenerationStream {
    /// Block the current thread until the next event arrives, or the channel
    /// is closed and drained (returns `None`).
    ///
    /// Terminal and ordinary events share a single queue so ordering is
    /// preserved and there is no wake-up race.
    #[napi]
    pub fn recv(&mut self) -> Option<GenerationEvent> {
        let mut guard = self.shared.queue.lock();
        loop {
            // Once a terminal has been delivered, always return None.
            if self.shared.terminal_seen.load(Ordering::Acquire) {
                return None;
            }
            if let Some(event) = guard.pop_front() {
                // Track terminal delivery so subsequent recv() calls return None.
                if is_terminal(&event) {
                    self.shared.terminal_seen.store(true, Ordering::Release);
                }
                // Wake a producer that might be waiting for space.
                self.shared.cv.notify_one();
                return Some(event);
            }
            // No data: if closed or the sender is gone, we are done.
            if self.shared.closed.load(Ordering::Acquire)
                || !self.shared.sender_alive.load(Ordering::Acquire)
            {
                return None;
            }
            self.shared.cv.wait(&mut guard);
        }
    }

    /// Attempt to receive an event without blocking.
    ///
    /// Returns `None` when the queue is empty but still open, or closed
    /// and drained.
    #[napi]
    pub fn try_recv(&mut self) -> Option<GenerationEvent> {
        let mut guard = self.shared.queue.lock();
        if self.shared.terminal_seen.load(Ordering::Acquire) {
            return None;
        }
        let event = guard.pop_front();
        if event.is_some() {
            if let Some(ref e) = event {
                if is_terminal(e) {
                    self.shared.terminal_seen.store(true, Ordering::Release);
                }
            }
            self.shared.cv.notify_one();
        }
        event
    }

    /// Close the stream — signals the sender via `is_closed()` that the
    /// consumer has disconnected. Subsequent `try_send_or_cancel` calls on
    /// the sender return `Cancelled`.
    ///
    /// Already-queued events (including terminal events sent afterwards via
    /// [`send_terminal`](GenerationSender::send_terminal)) will still be
    /// drained by [`recv`](Self::recv) before it returns `None`.
    #[napi]
    pub fn close(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        // Fire the disconnect oneshot so any waiting receiver is woken.
        if let Some(tx) = self.disconnect_tx.take() {
            let _ = tx.send(());
        }
        // Wake any blocked consumer so it sees the closed flag.
        self.shared.cv.notify_all();
    }

    /// Returns `true` once [`close`](Self::close) has been called.
    #[napi]
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
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

// Drop impl: when the stream is dropped without an explicit close, mark
// the queue closed so any blocked sender or consumer can unblock.
impl Drop for GenerationStream {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        self.shared.cv.notify_all();
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
/// Terminal events sent via [`send_terminal`] bypass the capacity check and
/// are therefore guaranteed to arrive even when the main event buffer is full.
#[napi]
pub struct GenerationSender {
    shared: Arc<SharedQueue>,
}

#[napi]
impl GenerationSender {
    /// Try to send an event without blocking.
    ///
    /// Returns an error when the channel is full (the caller should retry
    /// after the consumer drains) or closed (the consumer dropped the stream).
    #[napi]
    pub fn try_send(&self, event: GenerationEvent) -> napi::Result<()> {
        let mut guard = self.shared.queue.lock();
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("channel closed"));
        }
        if guard.len() >= self.shared.capacity {
            return Err(napi::Error::from_reason("channel full"));
        }
        guard.push_back(event);
        self.shared.cv.notify_one();
        Ok(())
    }

    /// Block the current thread until the event is sent.
    ///
    /// Fails when the consumer has dropped the stream.
    #[napi]
    pub fn blocking_send(&self, event: GenerationEvent) -> napi::Result<()> {
        let mut guard = self.shared.queue.lock();
        while guard.len() >= self.shared.capacity {
            if self.shared.closed.load(Ordering::Acquire) {
                return Err(napi::Error::from_reason("channel closed"));
            }
            self.shared.cv.wait(&mut guard);
        }
        guard.push_back(event);
        self.shared.cv.notify_one();
        Ok(())
    }

    /// Send a terminal event through the unified queue, bypassing the
    /// capacity limit.
    ///
    /// This always succeeds — the event will be delivered even if the
    /// main event buffer is completely full. If the consumer has already
    /// closed the stream, the event is still queued for draining.
    #[napi]
    pub fn send_terminal(&self, event: GenerationEvent) {
        let mut guard = self.shared.queue.lock();
        guard.push_back(event);
        self.shared.cv.notify_one();
    }

    /// Attempt to send, returning an immediate `"Cancelled"` error when
    /// the consumer has closed the stream.
    ///
    /// This is the preferred method for backends that want to avoid
    /// unnecessary work once the consumer has disconnected.
    #[napi]
    pub fn try_send_or_cancel(&self, event: GenerationEvent) -> napi::Result<()> {
        let mut guard = self.shared.queue.lock();
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("Cancelled"));
        }
        if guard.len() >= self.shared.capacity {
            return Err(napi::Error::from_reason("channel full"));
        }
        guard.push_back(event);
        self.shared.cv.notify_one();
        Ok(())
    }

    /// Check whether the consumer has dropped (closed) the stream.
    #[napi]
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }

    /// Maximum capacity the channel was created with.
    #[napi]
    pub fn capacity(&self) -> usize {
        self.shared.capacity
    }

    /// Returns `true` when the consumer has disconnected from the stream.
    ///
    /// Backends should check this before performing expensive work.
    pub fn is_disconnected(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
}

// When the sender is dropped, signal the consumer that no more events
// will arrive (the sender is gone).
impl Drop for GenerationSender {
    fn drop(&mut self) {
        self.shared.sender_alive.store(false, Ordering::Release);
        self.shared.cv.notify_all();
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
/// bypass the capacity limit and are unaffected by this value.
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
    let shared = Arc::new(SharedQueue::new(cap));
    let (disconnect_tx, disconnect_rx) = tokio::sync::oneshot::channel();
    (
        GenerationSender {
            shared: shared.clone(),
        },
        GenerationStream {
            shared,
            disconnect_tx: Some(disconnect_tx),
            disconnect_rx: Some(disconnect_rx),
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

    /// Basic round-trip through the channel.
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

        // Fill the channel.
        tx.try_send(GenerationEvent::Token(1)).unwrap();
        assert!(tx.try_send(GenerationEvent::Token(2)).is_err()); // full

        // Terminal still gets through (bypasses capacity).
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

    /// Terminal events are received even after the stream is closed.
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

    /// Terminal events pass validation.
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
        // At this point the queue is empty, so the terminal
        // from the other thread should arrive.
        done.store(true, Ordering::SeqCst);
        assert!(matches!(rx.recv(), Some(GenerationEvent::Done)));
        assert!(rx.recv().is_none());
    }

    /// Prove that a blocking receive returns a terminal event rather than
    /// None when the stream closes with a terminal still pending.
    #[test]
    fn test_blocking_recv_returns_pending_terminal_not_none() {
        let (tx, mut rx) = generation_channel(Some(2));
        // Enqueue one ordinary event, then close the stream.
        tx.try_send(GenerationEvent::Token(1)).unwrap();
        rx.close(); // marks closed, terminal channel remains open for delivery
        // Send terminal via the unified queue.
        tx.send_terminal(GenerationEvent::Done);

        // Drain the already-enqueued ordinary event.
        rx.recv(); // Token(1)
        // Now queue has only the terminal — recv must not return None.
        let final_event = rx.recv();
        assert!(
            matches!(final_event, Some(GenerationEvent::Done)),
            "blocking recv returned {:?} instead of Some(Done)",
            final_event
        );
    }

    /// Consumer begins blocking recv before terminal is sent; sender sends
    /// terminal on a separate thread; consumer receives it (not None).
    ///
    /// This proves the wake-up race between the old dual-channel design is
    /// closed: the consumer blocks on a single condvar that is awoken when
    /// the terminal arrives.
    #[test]
    fn test_terminal_wakes_blocked_recv() {
        let (tx, mut rx) = generation_channel(Some(2));

        // Start consumer in another thread — it will block on recv().
        let handle = std::thread::spawn(move || {
            // This blocks until the terminal event arrives.
            match rx.recv() {
                Some(GenerationEvent::Done) => true,
                other => {
                    eprintln!("Expected Some(Done), got {:?}", other);
                    false
                }
            }
        });

        // Give the consumer time to start blocking on recv.
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Send terminal — should wake the blocked consumer.
        tx.send_terminal(GenerationEvent::Done);

        assert!(
            handle.join().unwrap(),
            "consumer should have received Some(Done), not None"
        );
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
