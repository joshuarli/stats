use crate::backoff::Backoff;
use crate::cgroup;
use crate::config::{load_token_file, AgentConfig, ConfigError};
use crate::model::{Block, BootId, Sample, Unavailable};
use crate::queue::Queue;
use crate::sample_once;
use crate::transport::{HttpTransport, SendOutcome, TransportError};
use crate::wire::{EncodeError, EncodedBatch};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub static STOP: AtomicBool = AtomicBool::new(false);
const CREDENTIAL_RETRY: Duration = Duration::from_secs(60);
const FAILURE_LOG_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    BootIdentity,
    Transport(TransportError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BootIdentity => formatter.write_str("could not read a valid boot id"),
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
    fn prepare(&self, boot_id: &BootId, samples: &[Sample]) -> Result<EncodedBatch, EncodeError>;
    fn deliver(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError>;
    fn deliver_final(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        self.deliver(batch)
    }
    fn replace_token(&self, _token: String) -> bool {
        false
    }
}

impl BatchSender for HttpTransport {
    fn prepare(&self, boot_id: &BootId, samples: &[Sample]) -> Result<EncodedBatch, EncodeError> {
        HttpTransport::prepare(self, boot_id, samples)
    }

    fn deliver(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        HttpTransport::deliver(self, batch)
    }

    fn deliver_final(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        HttpTransport::deliver_final(self, batch)
    }

    fn replace_token(&self, token: String) -> bool {
        HttpTransport::replace_token(self, token)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub sampled: u64,
    pub sample_failures: u64,
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected_by_server: u64,
    pub dropped_local: u64,
    pub upload_failures: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlushOutcome {
    Idle,
    Sent(SendOutcome),
    Retry { delay: Duration, failure: TransportError },
    Dropped { samples: u64, failure: TransportError },
}

impl FlushOutcome {
    fn is_credential_failure(&self) -> bool {
        matches!(self, Self::Retry { failure: TransportError::Credential(_), .. })
    }

    fn record(&self, report: &mut RunReport, failure_log: &mut FailureLog, backoff: &mut Backoff) {
        match self {
            Self::Idle => {}
            Self::Sent(sent) => {
                report.accepted += sent.accepted;
                report.duplicates += sent.duplicates;
                report.rejected_by_server += sent.rejected;
                backoff.reset();
                failure_log.reset();
            }
            Self::Retry { failure, .. } => {
                report.upload_failures += 1;
                log_failure(failure_log, failure);
            }
            Self::Dropped { samples, failure } => {
                report.dropped_local += samples;
                log_failure(failure_log, failure);
            }
        }
    }
}

fn log_failure(failure_log: &mut FailureLog, failure: &TransportError) {
    if let Some(line) = failure_log.record(failure, Instant::now()) {
        eprintln!("{line}");
    }
}

#[derive(Default)]
struct FailureLog {
    last: Option<(String, Instant)>,
    suppressed: u64,
}

impl FailureLog {
    fn record(&mut self, error: &TransportError, now: Instant) -> Option<String> {
        let line = format!("stats: upload failed: {error}");
        match self.last.as_mut() {
            Some((previous, since)) if *previous == line => {
                self.suppressed += 1;
                if now.saturating_duration_since(*since) < FAILURE_LOG_INTERVAL {
                    return None;
                }
                let repeated = self.suppressed;
                *since = now;
                self.suppressed = 0;
                Some(format!("{line} (repeated {repeated} times)"))
            }
            _ => {
                self.last = Some((line.clone(), now));
                self.suppressed = 0;
                Some(line)
            }
        }
    }

    fn reset(&mut self) {
        self.last = None;
        self.suppressed = 0;
    }
}

pub fn flush_once(queue: &Arc<Mutex<Queue>>, sender: &dyn BatchSender, boot_id: &BootId, backoff: &mut Backoff) -> FlushOutcome {
    flush_batch(queue, sender, boot_id, backoff, false)
}

fn requeue(queue: &Arc<Mutex<Queue>>, samples: Vec<Sample>) {
    if !samples.is_empty() {
        queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).requeue_front(samples);
    }
}

fn flush_batch(queue: &Arc<Mutex<Queue>>, sender: &dyn BatchSender, boot_id: &BootId, backoff: &mut Backoff, final_flush: bool) -> FlushOutcome {
    let mut batch = {
        let mut queue = queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let limit = if queue.len() > 2 { 16 } else { 2 };
        queue.take_batch(limit)
    };
    if batch.is_empty() {
        return FlushOutcome::Idle;
    }
    let encoded = match sender.prepare(boot_id, &batch) {
        Ok(encoded) => encoded,
        Err(error) => {
            requeue(queue, batch.split_off(1));
            return FlushOutcome::Dropped { samples: 1, failure: TransportError::Permanent(error.to_string()) };
        }
    };
    requeue(queue, batch.split_off(encoded.samples()));
    let result = if final_flush { sender.deliver_final(&encoded) } else { sender.deliver(&encoded) };
    match result {
        Ok(outcome) => FlushOutcome::Sent(outcome),
        Err(error) => {
            let delay = match &error {
                TransportError::RateLimited(retry_after) => backoff.delay(*retry_after),
                TransportError::Retryable(_) => backoff.delay(None),
                TransportError::Credential(_) => backoff.delay(Some(CREDENTIAL_RETRY)),
                TransportError::Permanent(_) | TransportError::Protocol(_) => {
                    return FlushOutcome::Dropped { samples: batch.len() as u64, failure: error };
                }
            };
            requeue(queue, batch);
            FlushOutcome::Retry { delay, failure: error }
        }
    }
}

fn reload_token(sender: &dyn BatchSender, token_file: &Path) -> Result<(), ConfigError> {
    let token = load_token_file(token_file)?;
    sender.replace_token(token);
    Ok(())
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

fn upload_loop(queue: Arc<Mutex<Queue>>, sender: Arc<dyn BatchSender>, boot_id: BootId, interval: Duration, token_file: PathBuf, stop: &'static AtomicBool) -> RunReport {
    let mut report = RunReport::default();
    let mut failure_log = FailureLog::default();
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), std::process::id() as u64 ^ 0x9e37_79b9);
    'upload: while sleep_interruptible(interval, stop) {
        let mut outcome = flush_once(&queue, sender.as_ref(), &boot_id, &mut backoff);
        loop {
            outcome.record(&mut report, &mut failure_log, &mut backoff);
            if let FlushOutcome::Retry { delay, .. } = &outcome {
                if !sleep_interruptible(*delay, stop) {
                    break 'upload;
                }
                if outcome.is_credential_failure() {
                    if let Err(error) = reload_token(sender.as_ref(), &token_file) {
                        eprintln!("stats: token reload failed: {error}");
                    }
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
        let outcome = flush_batch(&queue, sender.as_ref(), &boot_id, &mut backoff, true);
        outcome.record(&mut report, &mut failure_log, &mut backoff);
        if matches!(outcome, FlushOutcome::Retry { .. }) || Instant::now() >= deadline {
            break;
        }
    }
    report.dropped_local += queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len() as u64;
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

struct BlockSampling {
    #[cfg(all(target_os = "linux", feature = "block-latency"))]
    probe: Option<crate::block_bpf::Probe>,
}

impl BlockSampling {
    fn new() -> Self {
        Self {
            #[cfg(all(target_os = "linux", feature = "block-latency"))]
            probe: crate::block_bpf::Probe::load(),
        }
    }

    fn read(&mut self) -> Option<Block> {
        #[cfg(all(target_os = "linux", feature = "block-latency"))]
        {
            if let Some(probe) = &mut self.probe {
                return probe.poll();
            }
        }
        None
    }
}

fn collect_sample(config: &AgentConfig, sampling: &mut BlockSampling) -> Option<Sample> {
    let mut sample = sample_once(config.scope())?;
    if let Some(block) = sampling.read() {
        sample.block = Some(block);
    }
    if !config.services.is_empty() {
        match cgroup::read_services(Path::new(cgroup::ROOT), &config.services) {
            Some(services) => sample.services = Some(services),
            None => sample.mark_unavailable(Unavailable::Services),
        }
    }
    Some(sample)
}

pub fn run(config: &AgentConfig, token: String) -> Result<RunReport, RuntimeError> {
    let boot_id: BootId = crate::boot_identity().and_then(|text| text.parse().ok()).ok_or(RuntimeError::BootIdentity)?;
    let mut transport = HttpTransport::new(&config.endpoint, &config.host_id, &token, Duration::from_millis(config.request_timeout_ms))?;
    match crate::system_info().ok_or_else(|| "system information is unavailable".to_owned()).and_then(|info| transport.announce(info)) {
        Ok(()) => {}
        Err(error) => eprintln!("stats: {error}; the host page will not show it"),
    }
    let sender: Arc<dyn BatchSender> = Arc::new(transport);
    let queue = Arc::new(Mutex::new(Queue::new(config.max_queue_samples)));
    let stop = &STOP;
    stop.store(false, Ordering::SeqCst);

    let uploader = {
        let queue = Arc::clone(&queue);
        let sender = Arc::clone(&sender);
        let interval = Duration::from_millis(config.upload_interval_ms);
        let token_file = config.token_file.clone();
        thread::spawn(move || upload_loop(queue, sender, boot_id, interval, token_file, stop))
    };

    let mut report = RunReport::default();
    let interval = Duration::from_millis(config.sample_interval_ms);
    let mut sampling = BlockSampling::new();
    if let Some(sample) = collect_sample(config, &mut sampling) {
        queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sample);
        report.sampled += 1;
    } else {
        report.sample_failures += 1;
    }
    while sleep_interruptible(interval, stop) {
        if let Some(sample) = collect_sample(config, &mut sampling) {
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
    report.rejected_by_server = uploaded.rejected_by_server;
    report.dropped_local = uploaded.dropped_local + queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).dropped();
    report.upload_failures = uploaded.upload_failures;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch;
    use std::sync::{Barrier, Mutex};

    struct FakeSender {
        results: Mutex<Vec<Result<SendOutcome, TransportError>>>,
        batches: Mutex<Vec<usize>>,
        sent: Mutex<Vec<Vec<u64>>>,
        tokens: Mutex<Vec<String>>,
        fit: usize,
    }

    impl FakeSender {
        fn new(results: Vec<Result<SendOutcome, TransportError>>) -> Self {
            Self { results: Mutex::new(results), batches: Mutex::new(Vec::new()), sent: Mutex::new(Vec::new()), tokens: Mutex::new(Vec::new()), fit: 16 }
        }

        fn limited(results: Vec<Result<SendOutcome, TransportError>>, fit: usize) -> Self {
            Self { fit, ..Self::new(results) }
        }
    }

    impl BatchSender for FakeSender {
        fn prepare(&self, boot_id: &BootId, samples: &[Sample]) -> Result<EncodedBatch, EncodeError> {
            let host = "h_0123456789abcdef0123456789abcdef".parse().unwrap();
            crate::wire::encode_batch(&host, boot_id, None, &samples[..samples.len().min(self.fit)], crate::wire::MAX_BODY)
        }

        fn deliver(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
            self.batches.lock().unwrap().push(batch.samples());
            self.sent.lock().unwrap().push(batch.seqs.clone());
            self.results.lock().unwrap().remove(0)
        }

        fn replace_token(&self, token: String) -> bool {
            self.tokens.lock().unwrap().push(token);
            true
        }
    }

    fn queue(samples: usize) -> Arc<Mutex<Queue>> {
        let mut value = Queue::new(16);
        for index in 0..samples {
            value.push(sample(index as u64));
        }
        Arc::new(Mutex::new(value))
    }

    fn sample(seq: u64) -> Sample {
        Sample { uptime_ms: Some(seq * 1000), ..Sample::empty(seq, seq, seq * 1000) }
    }

    fn boot() -> BootId {
        "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".parse().unwrap()
    }

    fn write_token(path: &Path, token: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, token).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn retryable_failures_requeue_and_retry() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Retryable("offline".into())), Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let first = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(matches!(first, FlushOutcome::Retry { .. }));
        assert_eq!(queue.lock().unwrap().len(), 2);
        let second = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert_eq!(second, FlushOutcome::Sent(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 }));
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn permanent_failures_drop_the_batch() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Permanent("bad request".into()))]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let outcome = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(matches!(outcome, FlushOutcome::Dropped { samples: 2, failure: TransportError::Permanent(_) }));
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn backlog_batches_up_to_sixteen_and_normal_batches_two() {
        let backlog = queue(10);
        let sender = FakeSender::new(vec![Ok(SendOutcome { accepted: 10, duplicates: 0, rejected: 0 })]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        flush_once(&backlog, &sender, &boot(), &mut backoff);
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [10]);

        let normal = queue(2);
        let sender = FakeSender::new(vec![Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })]);
        flush_once(&normal, &sender, &boot(), &mut backoff);
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [2]);
    }

    #[test]
    fn trims_a_batch_that_does_not_fit_and_keeps_the_tail() {
        let queue = queue(5);
        let sender = FakeSender::limited(vec![Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })], 2);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let outcome = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert_eq!(outcome, FlushOutcome::Sent(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 }));
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [2]);
        let remaining: Vec<u64> = queue.lock().unwrap().take_batch(10).iter().map(|sample| sample.seq).collect();
        assert_eq!(remaining, [2, 3, 4]);
    }

    #[test]
    fn a_retried_cut_batch_keeps_queue_order_and_reencodes_from_absolute_bases() {
        let queue = queue(5);
        let sender = FakeSender::limited(vec![Err(TransportError::Retryable("offline".into())), Ok(SendOutcome { accepted: 3, duplicates: 0, rejected: 0 }), Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })], 3);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        assert!(matches!(flush_once(&queue, &sender, &boot(), &mut backoff), FlushOutcome::Retry { .. }));
        assert_eq!(queue.lock().unwrap().len(), 5);
        flush_once(&queue, &sender, &boot(), &mut backoff);
        flush_once(&queue, &sender, &boot(), &mut backoff);
        assert_eq!(sender.sent.lock().unwrap().as_slice(), [vec![0, 1, 2], vec![0, 1, 2], vec![3, 4]]);
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unencodable_sample_is_dropped_alone_and_never_retried() {
        let mut value = Queue::new(16);
        let mut bad = sample(0);
        bad.unavailable.push(crate::model::Unavailable::Uptime);
        value.push(bad);
        value.push(sample(1));
        let queue = Arc::new(Mutex::new(value));
        let sender = FakeSender::new(vec![Ok(SendOutcome { accepted: 1, duplicates: 0, rejected: 0 })]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let first = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(matches!(first, FlushOutcome::Dropped { samples: 1, failure: TransportError::Permanent(_) }));
        assert!(sender.sent.lock().unwrap().is_empty());
        flush_once(&queue, &sender, &boot(), &mut backoff);
        assert_eq!(sender.sent.lock().unwrap().as_slice(), [vec![1]]);
    }

    #[test]
    fn protocol_failures_drop_the_batch_without_retrying() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Protocol("server returned 410".into()))]);
        let mut backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(4), 3);
        let outcome = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(matches!(outcome, FlushOutcome::Dropped { samples: 2, failure: TransportError::Protocol(_) }));
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn rate_limit_delay_is_used() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::RateLimited(Some(Duration::from_secs(3))))]);
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), 5);
        let outcome = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(matches!(outcome, FlushOutcome::Retry { delay, failure: TransportError::RateLimited(_) } if delay == Duration::from_secs(3)));
        assert_eq!(queue.lock().unwrap().len(), 2);
    }

    #[test]
    fn credential_failures_keep_the_batch_for_a_minute() {
        let queue = queue(2);
        let sender = FakeSender::new(vec![Err(TransportError::Credential("server returned 401".into()))]);
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), 5);
        let outcome = flush_once(&queue, &sender, &boot(), &mut backoff);
        assert!(outcome.is_credential_failure());
        assert!(matches!(outcome, FlushOutcome::Retry { delay, .. } if delay == Duration::from_secs(60)));
        assert_eq!(queue.lock().unwrap().len(), 2);
    }

    #[test]
    fn every_outcome_is_recorded_the_same_way() {
        let mut report = RunReport::default();
        let mut failure_log = FailureLog::default();
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), 5);
        backoff.delay(None);
        backoff.delay(None);
        FlushOutcome::Sent(SendOutcome { accepted: 3, duplicates: 1, rejected: 2 }).record(&mut report, &mut failure_log, &mut backoff);
        assert_eq!((report.accepted, report.duplicates, report.rejected_by_server), (3, 1, 2));
        assert!((1000..=1200).contains(&backoff.delay(None).as_millis()));
        FlushOutcome::Retry { delay: Duration::from_secs(1), failure: TransportError::Retryable("offline".into()) }.record(&mut report, &mut failure_log, &mut backoff);
        FlushOutcome::Dropped { samples: 4, failure: TransportError::Permanent("bad".into()) }.record(&mut report, &mut failure_log, &mut backoff);
        FlushOutcome::Idle.record(&mut report, &mut failure_log, &mut backoff);
        assert_eq!((report.upload_failures, report.dropped_local), (1, 4));
    }

    #[test]
    fn reloads_a_changed_token_file() {
        let root = scratch("runtime");
        let token_file = root.join("token");
        let token = "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
        write_token(&token_file, token);
        let sender = FakeSender::new(vec![]);
        reload_token(&sender, &token_file).unwrap();
        assert_eq!(sender.tokens.lock().unwrap().as_slice(), [token]);
    }

    #[test]
    fn logs_a_failure_once_and_then_counts_repeats_per_minute() {
        let mut log = FailureLog::default();
        let error = TransportError::Retryable("offline".into());
        let start = Instant::now();
        assert_eq!(log.record(&error, start), Some("stats: upload failed: retryable: offline".to_owned()));
        assert_eq!(log.record(&error, start + Duration::from_secs(1)), None);
        assert_eq!(log.record(&error, start + Duration::from_secs(61)), Some("stats: upload failed: retryable: offline (repeated 2 times)".to_owned()));
        log.reset();
        assert!(log.record(&error, start + Duration::from_secs(62)).is_some());
    }

    #[test]
    fn stop_flag_is_visible_to_sleepers() {
        let stop: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(false)));
        let pair = Arc::new(Barrier::new(2));
        let setter = stop;
        let arrival = Arc::clone(&pair);
        let handle = thread::spawn(move || {
            arrival.wait();
            setter.store(true, Ordering::SeqCst);
        });
        pair.wait();
        let started = Instant::now();
        assert!(!sleep_interruptible(Duration::from_secs(10), stop));
        assert!(started.elapsed() < Duration::from_secs(5));
        handle.join().unwrap();
    }

    #[test]
    fn stop_flushes_pending_samples_before_exiting() {
        let queue = queue(2);
        let sender = Arc::new(FakeSender::new(vec![Ok(SendOutcome { accepted: 2, duplicates: 0, rejected: 0 })]));
        let stop: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(true)));
        let report = upload_loop(Arc::clone(&queue), sender.clone(), boot(), Duration::from_secs(3_600), PathBuf::from("/nonexistent"), stop);
        assert_eq!(report.accepted, 2);
        assert_eq!(sender.batches.lock().unwrap().as_slice(), [2]);
        assert!(queue.lock().unwrap().is_empty());
    }
}
