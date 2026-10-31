use crate::backoff::Backoff;
use crate::block;
use crate::config::AgentConfig;
use crate::model::Sample;
use crate::queue::Queue;
use crate::sample_once;
use crate::transport::{HttpTransport, SendOutcome, TransportError};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    BootIdentity,
    Transport(TransportError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BootIdentity => formatter.write_str("could not read a valid Linux boot id"),
            Self::Transport(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl From<TransportError> for RuntimeError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

pub trait BatchSender: Send + Sync {
    fn send(&self, boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError>;
}

impl BatchSender for HttpTransport {
    fn send(&self, boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
        HttpTransport::send(self, boot_id, samples)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub sampled: u64,
    pub sample_failures: u64,
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
    pub dropped: u64,
    pub upload_failures: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FlushOutcome {
    pub sent: Option<SendOutcome>,
    pub retry: Option<Duration>,
    pub dropped: u64,
}

pub fn flush_once(queue: &Arc<Mutex<Queue>>, sender: &dyn BatchSender, boot_id: &str, backoff: &mut Backoff) -> FlushOutcome {
    let (batch, pending) = {
        let mut queue = queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let limit = if queue.len() > 2 { 16 } else { 2 };
        let batch = queue.take_batch(limit);
        (batch, queue.len())
    };
    if batch.is_empty() {
        return FlushOutcome::default();
    }
    match sender.send(boot_id, &batch) {
        Ok(outcome) => {
            if pending == 0 {
                backoff.reset();
            }
            FlushOutcome { sent: Some(outcome), retry: None, dropped: 0 }
        }
        Err(TransportError::RateLimited(retry_after)) => {
            queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).requeue_front(batch);
            FlushOutcome { sent: None, retry: Some(backoff.delay(retry_after)), dropped: 0 }
        }
        Err(TransportError::Retryable(_)) => {
            queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).requeue_front(batch);
            FlushOutcome { sent: None, retry: Some(backoff.delay(None)), dropped: 0 }
        }
        Err(TransportError::Permanent(_)) => FlushOutcome { sent: None, retry: None, dropped: batch.len() as u64 },
    }
}

fn sleep_interruptible(duration: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + duration;
    loop {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(250)));
    }
}

fn upload_loop(queue: Arc<Mutex<Queue>>, sender: Arc<dyn BatchSender>, boot_id: String, interval: Duration, stop: &'static AtomicBool) -> RunReport {
    let mut report = RunReport::default();
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), std::process::id() as u64 ^ 0x9e37_79b9);
    'upload: while sleep_interruptible(interval, stop) {
        let mut outcome = flush_once(&queue, sender.as_ref(), &boot_id, &mut backoff);
        loop {
            if let Some(sent) = outcome.sent {
                report.accepted += sent.accepted;
                report.duplicates += sent.duplicates;
                report.rejected += sent.rejected;
                backoff.reset();
            }
            if outcome.dropped > 0 {
                report.rejected += outcome.dropped;
            }
            if let Some(delay) = outcome.retry {
                report.upload_failures += 1;
                if !sleep_interruptible(delay, stop) {
                    break 'upload;
                }
                outcome = flush_once(&queue, sender.as_ref(), &boot_id, &mut backoff);
                continue;
            }
            let pending = queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len();
            if pending <= 2 {
                break;
            }
            outcome = flush_once(&queue, sender.as_ref(), &boot_id, &mut backoff);
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_empty() {
            break;
        }
        let outcome = flush_once(&queue, sender.as_ref(), &boot_id, &mut backoff);
        if let Some(sent) = outcome.sent {
            report.accepted += sent.accepted;
            report.duplicates += sent.duplicates;
            report.rejected += sent.rejected;
        }
        if outcome.retry.is_some() || Instant::now() >= deadline {
            break;
        }
    }
    report
}

pub fn install_signal_handlers() -> Result<(), RuntimeError> {
    extern "C" fn stop(_: libc::c_int) {
        STOP.store(true, Ordering::SeqCst);
    }
    for signal in [libc::SIGTERM, libc::SIGINT] {
        let previous = unsafe { libc::signal(signal, stop as *const () as libc::sighandler_t) };
        if previous == libc::SIG_ERR {
            return Err(RuntimeError::Transport(TransportError::Permanent("could not install signal handler".to_owned())));
        }
    }
    Ok(())
}

fn sample_with_block(config: &AgentConfig) -> Option<Sample> {
    let mut sample = sample_once()?;
    if let Some(path) = &config.block_latency_file {
        if let Some(value) = block::read(path) {
            sample.block = Some(value);
        }
    }
    Some(sample)
}

pub fn run(config: &AgentConfig, token: String) -> Result<RunReport, RuntimeError> {
    let boot_id = crate::boot_identity().ok_or(RuntimeError::BootIdentity)?;
    let sender: Arc<dyn BatchSender> = Arc::new(HttpTransport::new(&config.endpoint, &config.host_id, &token, Duration::from_millis(config.request_timeout_ms))?);
    let queue = Arc::new(Mutex::new(Queue::new(config.max_queue_samples)));
    let stop = &STOP;
    stop.store(false, Ordering::SeqCst);

    let uploader = {
        let queue = Arc::clone(&queue);
        let sender = Arc::clone(&sender);
        let boot_id = boot_id.clone();
        let interval = Duration::from_millis(config.upload_interval_ms);
        thread::spawn(move || upload_loop(queue, sender, boot_id, interval, stop))
    };

    let mut report = RunReport::default();
    let interval = Duration::from_millis(config.sample_interval_ms);
    if let Some(sample) = sample_with_block(config) {
        queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sample);
        report.sampled += 1;
    } else {
        report.sample_failures += 1;
    }
    while sleep_interruptible(interval, stop) {
        if let Some(sample) = sample_with_block(config) {
            queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sample);
            report.sampled += 1;
        } else {
            report.sample_failures += 1;
        }
    }
    stop.store(true, Ordering::SeqCst);
    let uploaded = uploader.join().unwrap_or_default();
    report.accepted = uploaded.accepted;
    report.duplicates = uploaded.duplicates;
    report.rejected = uploaded.rejected;
    report.dropped = queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).dropped();
    report.upload_failures = uploaded.upload_failures;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeSender {
        results: Mutex<Vec<Result<SendOutcome, TransportError>>>,
        batches: Mutex<Vec<usize>>,
    }

    impl FakeSender {
        fn new(results: Vec<Result<SendOutcome, TransportError>>) -> Self {
            Self { results: Mutex::new(results), batches: Mutex::new(Vec::new()) }
        }
    }

    impl BatchSender for FakeSender {
        fn send(&self, _boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
            self.batches.lock().unwrap().push(samples.len());
            self.results.lock().unwrap().remove(0)
        }
    }

    fn queue(samples: usize) -> Arc<Mutex<Queue>> {
        let mut value = Queue::new(16);
        for index in 0..samples {
            value.push(Sample::empty(index as u64, index as u64, index as u64));
        }
        Arc::new(Mutex::new(value))
    }

    #[test]
    fn retryable_failures_requeue_and_retry() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Retryable("offline".into())), Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let first = flush_once(&queue, &sender, "boot", &mut backoff);
        assert!(first.retry.is_some());
        assert_eq!(queue.lock().unwrap().len(), 2);
        let second = flush_once(&queue, &sender, "boot", &mut backoff);
        assert_eq!(second.sent, Some(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 }));
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn permanent_failures_drop_the_batch() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Permanent("bad request".into()))]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let outcome = flush_once(&queue, &sender, "boot", &mut backoff);
        assert_eq!(outcome.dropped, 2);
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn backlog_batches_up_to_sixteen_and_normal_batches_two() {
        let backlog = queue(10);
        let sender = FakeSender::new(vec![Ok(SendOutcome { accepted: 10, duplicates: 0, rejected: 0 })]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        flush_once(&backlog, &sender, "boot", &mut backoff);
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [10]);

        let normal = queue(2);
        let sender = FakeSender::new(vec![Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })]);
        flush_once(&normal, &sender, "boot", &mut backoff);
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [2]);
    }

    #[test]
    fn rate_limit_delay_is_used() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::RateLimited(Some(Duration::from_secs(3))))]);
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), 5);
        let outcome = flush_once(&queue, &sender, "boot", &mut backoff);
        assert_eq!(outcome.retry, Some(Duration::from_secs(3)));
        assert_eq!(queue.lock().unwrap().len(), 2);
    }

    #[test]
    fn stop_flag_is_visible_to_sleepers() {
        let stop_ref: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(false)));
        let setter = stop_ref;
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            setter.store(true, Ordering::SeqCst);
        });
        assert!(!sleep_interruptible(Duration::from_secs(5), stop_ref));
    }
}
