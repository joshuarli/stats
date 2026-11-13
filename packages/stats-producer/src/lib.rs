mod backoff;
mod wire;

use backoff::backoff_delay;
use h12tiny_client_sync::http::{header, HeaderValue, Method, Request, Uri};
use h12tiny_client_sync::{Client, ClientTlsConfigBuilder};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub use wire::{MAX_BATCH_BYTES, MAX_EVENTS};
use wire::{decode_ack, encode_batch, WireBatch, WireDelivery, WireError, WireEvent, WireTrace, MAX_ACK_BYTES};

const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_WORK_VALUE: u64 = 1_000_000_000_000;
const MAX_WORK_MEASUREMENTS: usize = 16;
const SUCCESS_OUTCOME: &str = "ok";
const CONTENT_TYPE: &str = "application/json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trace {
    pub trace_id: String,
    pub span_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationEvent {
    pub operation: String,
    pub outcome: String,
    pub duration_ms: u64,
    pub work: BTreeMap<String, u64>,
    pub event_id: Option<String>,
    pub at_ms: Option<u64>,
    pub instance: Option<String>,
    pub host: Option<String>,
    pub trace: Option<Trace>,
    pub error_code: Option<String>,
}

impl OperationEvent {
    pub fn new(operation: impl Into<String>, outcome: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            operation: operation.into(),
            outcome: outcome.into(),
            duration_ms,
            work: BTreeMap::new(),
            event_id: None,
            at_ms: None,
            instance: None,
            host: None,
            trace: None,
            error_code: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProducerConfig {
    pub endpoint: String,
    pub service: String,
    pub token: String,
    pub release: String,
    pub instance: Option<String>,
    pub host: Option<String>,
    pub queue_limit: usize,
    pub batch_size: usize,
    pub flush_interval: Duration,
    pub timeout: Duration,
    pub max_retries: u32,
    pub backoff_base: Duration,
    pub max_retry_after: Duration,
}

impl Default for ProducerConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            service: String::new(),
            token: String::new(),
            release: String::new(),
            instance: None,
            host: None,
            queue_limit: 256,
            batch_size: 64,
            flush_interval: Duration::from_secs(5),
            timeout: Duration::from_secs(5),
            max_retries: 5,
            backoff_base: Duration::from_millis(250),
            max_retry_after: Duration::from_secs(30),
        }
    }
}

impl ProducerConfig {
    pub fn new(endpoint: impl Into<String>, service: impl Into<String>, token: impl Into<String>, release: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            service: service.into(),
            token: token.into(),
            release: release.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProducerError {
    Config(String),
    Worker(String),
}

impl fmt::Display for ProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(message) => write!(formatter, "configuration: {message}"),
            Self::Worker(message) => write!(formatter, "worker: {message}"),
        }
    }
}

impl std::error::Error for ProducerError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerStats {
    pub queued: usize,
    pub dropped: u64,
    pub sent: u64,
    pub duplicates: u64,
    pub batches: u64,
    pub retries: u64,
    pub last_error: Option<String>,
}

#[derive(Clone)]
struct Config {
    uri: Uri,
    service: String,
    release: String,
    instance: Option<String>,
    host: Option<String>,
    queue_limit: usize,
    batch_size: usize,
    flush_interval: Duration,
    timeout: Duration,
    max_retries: u32,
    backoff_base: Duration,
    max_retry_after: Duration,
}

struct QueuedEvent {
    event: WireEvent,
    size: usize,
}

struct State {
    queue: VecDeque<QueuedEvent>,
    flush_deadline: Option<Instant>,
    sending: bool,
    shutdown: bool,
    flush_requested: bool,
}

struct Inner {
    config: Config,
    state: Mutex<State>,
    wake: Condvar,
    token: Mutex<String>,
    accepted: AtomicU64,
    producer_id: String,
    started_at_ms: u64,
    dropped: AtomicU64,
    sent: AtomicU64,
    duplicates: AtomicU64,
    batches: AtomicU64,
    retries: AtomicU64,
    last_error: Mutex<Option<String>>,
    alive: AtomicBool,
    jitter: AtomicU64,
}

impl Inner {
    fn new(config: Config, token: String) -> Self {
        Self {
            config,
            state: Mutex::new(State { queue: VecDeque::new(), flush_deadline: None, sending: false, shutdown: false, flush_requested: false }),
            wake: Condvar::new(),
            token: Mutex::new(token),
            accepted: AtomicU64::new(0),
            producer_id: default_event_id(),
            started_at_ms: now_ms(),
            dropped: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            duplicates: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            retries: AtomicU64::new(0),
            last_error: Mutex::new(None),
            alive: AtomicBool::new(true),
            jitter: AtomicU64::new(now_ms() | 1),
        }
    }

    fn error(&self, message: impl Into<String>) {
        *self.last_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message.into());
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn next_jitter(&self) -> f64 {
        let mut value = self.jitter.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
        value ^= value >> 30;
        value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value ^= value >> 27;
        (value % 1000) as f64 / 1000.0
    }
}

pub struct Producer {
    inner: Option<Arc<Inner>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Producer {
    pub fn new(config: ProducerConfig) -> Result<Self, ProducerError> {
        let endpoint = config.endpoint.trim();
        let service = config.service.trim();
        let token = config.token.trim();
        let release = config.release.trim();
        if endpoint.is_empty() || service.is_empty() || token.is_empty() || release.is_empty() {
            return Ok(Self::disabled());
        }
        if !valid_service(service) {
            return Err(ProducerError::Config("service must be 1-32 lowercase letters, digits, or hyphens, starting with a letter".to_owned()));
        }
        if !valid_release(release) {
            return Err(ProducerError::Config("release must be 1-64 letters, digits, or ._:+- starting with a letter or digit".to_owned()));
        }
        if let Some(instance) = &config.instance {
            if !valid_label(instance) {
                return Err(ProducerError::Config("instance must be 1-128 letters, digits, or ._:- starting with a letter or digit".to_owned()));
            }
        }
        if let Some(host) = &config.host {
            if !valid_label(host) {
                return Err(ProducerError::Config("host must be 1-128 letters, digits, or ._:- starting with a letter or digit".to_owned()));
            }
        }
        if config.queue_limit == 0 || config.queue_limit > 256 {
            return Err(ProducerError::Config("queue_limit must be 1-256".to_owned()));
        }
        if config.batch_size == 0 || config.batch_size > MAX_EVENTS {
            return Err(ProducerError::Config(format!("batch_size must be 1-{MAX_EVENTS}")));
        }
        if config.flush_interval.is_zero() {
            return Err(ProducerError::Config("flush_interval must be positive".to_owned()));
        }
        if config.timeout.is_zero() {
            return Err(ProducerError::Config("timeout must be positive".to_owned()));
        }
        if config.max_retries > 10 {
            return Err(ProducerError::Config("max_retries must be at most 10".to_owned()));
        }
        if config.backoff_base.is_zero() || config.max_retry_after.is_zero() {
            return Err(ProducerError::Config("backoff limits must be positive".to_owned()));
        }
        let uri: Uri = format!("{}/ingest/observe/v1/{}/batches", endpoint.trim_end_matches('/'), service)
            .parse()
            .map_err(|error| ProducerError::Config(format!("endpoint: {error}")))?;
        if !matches!(uri.scheme_str(), Some("http") | Some("https")) || uri.authority().is_none() {
            return Err(ProducerError::Config("endpoint must be a bare http or https origin".to_owned()));
        }
        let resolved = Config {
            uri,
            service: service.to_owned(),
            release: release.to_owned(),
            instance: config.instance.clone(),
            host: config.host.clone(),
            queue_limit: config.queue_limit,
            batch_size: config.batch_size,
            flush_interval: config.flush_interval,
            timeout: config.timeout,
            max_retries: config.max_retries,
            backoff_base: config.backoff_base,
            max_retry_after: config.max_retry_after,
        };
        let inner = Arc::new(Inner::new(resolved, token.to_owned()));
        let worker = thread::Builder::new()
            .name("stats-producer".to_owned())
            .spawn({
                let inner = Arc::clone(&inner);
                move || run(inner)
            })
            .map_err(|error| ProducerError::Worker(format!("cannot start worker: {error}")))?;
        Ok(Self { inner: Some(inner), worker: Mutex::new(Some(worker)) })
    }

    fn disabled() -> Self {
        Self { inner: None, worker: Mutex::new(None) }
    }

    pub fn record(&self, event: OperationEvent) {
        let Some(inner) = &self.inner else { return };
        let Some(mut wire) = normalize(event, &inner.config) else {
            inner.dropped.fetch_add(1, Ordering::Relaxed);
            inner.error("invalid_event");
            return;
        };
        // Sequence is assigned under the lock; size the remaining immutable fields here.
        wire.delivery = Some(WireDelivery { id: inner.producer_id.clone(), sequence: 0, accepted: u64::MAX, dropped: u64::MAX, queued: inner.config.queue_limit as u64, started_at_ms: inner.started_at_ms, at_ms: u64::MAX });
        let size = deser_json::to_string(&wire).map(|json| json.len()).unwrap_or(usize::MAX);
        let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.shutdown {
            drop(state);
            inner.dropped.fetch_add(1, Ordering::Relaxed);
            inner.error("closed");
            return;
        }
        if state.queue.len() >= inner.config.queue_limit {
            state.queue.pop_front();
            inner.dropped.fetch_add(1, Ordering::Relaxed);
            inner.error("queue_overflow");
        }
        if state.queue.is_empty() {
            state.flush_deadline = Some(Instant::now() + inner.config.flush_interval);
        }
        let sequence = inner.accepted.fetch_add(1, Ordering::Relaxed) + 1;
        wire.delivery = Some(WireDelivery { id: inner.producer_id.clone(), sequence, accepted: sequence, dropped: 0, queued: 0, started_at_ms: inner.started_at_ms, at_ms: now_ms() });
        let size = size.saturating_add(sequence.to_string().len() - 1);
        state.queue.push_back(QueuedEvent { event: wire, size });
        inner.wake.notify_all();
    }

    pub fn flush(&self) -> Result<(), ProducerError> {
        let Some(inner) = &self.inner else { return Ok(()) };
        let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.flush_requested = true;
        inner.wake.notify_all();
        while !state.queue.is_empty() || state.sending {
            state.flush_requested = true;
            inner.wake.notify_all();
            if !inner.alive.load(Ordering::Relaxed) {
                return Err(ProducerError::Worker("worker stopped".to_owned()));
            }
            let (next, timeout) = inner.wake.wait_timeout(state, Duration::from_millis(100)).map_err(|_| ProducerError::Worker("producer lock poisoned".to_owned()))?;
            state = next;
            if timeout.timed_out() && !inner.alive.load(Ordering::Relaxed) {
                return Err(ProducerError::Worker("worker stopped".to_owned()));
            }
        }
        state.flush_requested = false;
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), ProducerError> {
        let Some(inner) = &self.inner else { return Ok(()) };
        {
            let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.shutdown = true;
            inner.wake.notify_all();
        }
        let flushed = self.flush();
        let handle = self.worker.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        let joined = match handle {
            Some(handle) => handle.join().map_err(|_| ProducerError::Worker("worker panicked".to_owned())),
            None => Ok(()),
        };
        flushed.and(joined)
    }

    pub fn replace_token(&self, token: String) -> bool {
        let Some(inner) = &self.inner else { return false };
        let mut current = inner.token.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == token {
            return false;
        }
        *current = token;
        true
    }

    pub fn stats(&self) -> ProducerStats {
        let Some(inner) = &self.inner else {
            return ProducerStats { queued: 0, dropped: 0, sent: 0, duplicates: 0, batches: 0, retries: 0, last_error: None };
        };
        let state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ProducerStats {
            queued: state.queue.len(),
            dropped: inner.dropped.load(Ordering::Relaxed),
            sent: inner.sent.load(Ordering::Relaxed),
            duplicates: inner.duplicates.load(Ordering::Relaxed),
            batches: inner.batches.load(Ordering::Relaxed),
            retries: inner.retries.load(Ordering::Relaxed),
            last_error: inner.last_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
        }
    }
}

impl Drop for Producer {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn run(inner: Arc<Inner>) {
    let config = inner.config.clone();
    let client = match build_client(config.timeout) {
        Ok(client) => client,
        Err(error) => {
            inner.error(error);
            inner.alive.store(false, Ordering::Relaxed);
            inner.wake.notify_all();
            return;
        }
    };
    loop {
        let batch = {
            let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                if state.shutdown && state.queue.is_empty() {
                    inner.alive.store(false, Ordering::Relaxed);
                    inner.wake.notify_all();
                    return;
                }
                if !state.queue.is_empty() && (state.queue.len() >= config.batch_size || state.flush_requested || state.shutdown) {
                    state.sending = true;
                    state.flush_requested = false;
                    break take_batch(&mut state, &inner);
                }
                if state.queue.is_empty() {
                    state = inner.wake.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
                    continue;
                }
                let remaining = state.flush_deadline.unwrap().saturating_duration_since(Instant::now());
                let (next, timeout) = inner.wake.wait_timeout(state, remaining).unwrap_or_else(|poisoned| poisoned.into_inner());
                state = next;
                if timeout.timed_out() && !state.flush_requested && state.queue.len() < config.batch_size && !state.shutdown {
                    state.sending = true;
                    break take_batch(&mut state, &inner);
                }
            }
        };
        if !batch.events.is_empty() {
            if let Err(error) = send_batch(&client, &inner, &config, &batch) {
                inner.dropped.fetch_add(batch.events.len() as u64, Ordering::Relaxed);
                inner.error(error);
            }
        }
        let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sending = false;
        inner.wake.notify_all();
    }
}

fn take_batch(state: &mut State, inner: &Inner) -> WireBatch {
    let mut events = Vec::new();
    let mut size: usize = 13; // {"events":[]}
    while events.len() < inner.config.batch_size {
        let Some(front) = state.queue.front() else { break };
        let added = front.size.saturating_add(usize::from(!events.is_empty()));
        if size.saturating_add(added) > MAX_BATCH_BYTES {
            if events.is_empty() {
                state.queue.pop_front();
                inner.dropped.fetch_add(1, Ordering::Relaxed);
                inner.error("event_too_large");
                continue;
            }
            break;
        }
        size += added;
        events.push(state.queue.pop_front().unwrap().event);
    }
    if state.queue.is_empty() {
        state.flush_deadline = None;
    }
    for event in &mut events {
        if let Some(delivery) = &mut event.delivery {
            delivery.accepted = inner.accepted.load(Ordering::Relaxed);
            delivery.dropped = inner.dropped.load(Ordering::Relaxed);
            delivery.queued = state.queue.len() as u64;
            delivery.at_ms = now_ms();
        }
    }
    WireBatch { events }
}

fn send_batch(client: &Client, inner: &Inner, config: &Config, batch: &WireBatch) -> Result<(), String> {
    let body = encode_batch(batch)?;
    for attempt in 0..=config.max_retries {
        let used = inner.token();
        let mut authorization = HeaderValue::try_from(format!("Bearer {used}")).map_err(|_| "token is not a header value".to_owned())?;
        authorization.set_sensitive(true);
        let request = Request::builder()
            .method(Method::POST)
            .uri(config.uri.clone())
            .header(header::AUTHORIZATION, authorization)
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .header(header::USER_AGENT, concat!("stats-producer/", env!("CARGO_PKG_VERSION")))
            .body(body.clone())
            .map_err(|error| format!("bad request: {error}"))?;
        let started = Instant::now();
        let mut response = match client.request_with_timeout(request, Some(config.timeout)) {
            Ok(response) => response,
            Err(_) => {
                if attempt == config.max_retries {
                    return Err("timeout_or_network".to_owned());
                }
                inner.retries.fetch_add(1, Ordering::Relaxed);
                thread::sleep(backoff_delay(attempt, config.backoff_base, inner.next_jitter(), config.max_retry_after));
                continue;
            }
        };
        let status = response.status().as_u16();
        if (200..=299).contains(&status) {
            let body = read_bounded(response.body_mut(), started + config.timeout, MAX_ACK_BYTES).unwrap_or_default();
            if let Some(ack) = decode_ack(&body) {
                inner.sent.fetch_add(ack.accepted, Ordering::Relaxed);
                inner.duplicates.fetch_add(ack.duplicate, Ordering::Relaxed);
                inner.batches.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            if attempt == config.max_retries {
                return Err("malformed_response".to_owned());
            }
            inner.retries.fetch_add(1, Ordering::Relaxed);
            thread::sleep(backoff_delay(attempt, config.backoff_base, inner.next_jitter(), config.max_retry_after));
            continue;
        }
        if status == 401 || status == 403 {
            if inner.token() != used && attempt < config.max_retries {
                inner.retries.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            return Err(format!("http_{status}"));
        }
        if status == 408 || status == 425 || status == 429 || status >= 500 {
            if attempt == config.max_retries {
                return Err(format!("http_{status}"));
            }
            let retry_after = header_text(&response, header::RETRY_AFTER).and_then(|text| text.parse::<u64>().ok()).map(Duration::from_secs);
            let delay = retry_after.map_or_else(|| backoff_delay(attempt, config.backoff_base, inner.next_jitter(), config.max_retry_after), |delay| delay.min(config.max_retry_after));
            inner.retries.fetch_add(1, Ordering::Relaxed);
            thread::sleep(delay);
            continue;
        }
        return Err(format!("http_{status}"));
    }
    Err("retry_exhausted".to_owned())
}

fn build_client(timeout: Duration) -> Result<Client, String> {
    let tls = ClientTlsConfigBuilder::new().build().map_err(|error| format!("system trust roots: {error}"))?;
    let builder = Client::builder().connect_timeout(timeout).map_err(|error| format!("client: {error}"))?;
    Ok(builder.tls_config(tls).build())
}

fn header_text(response: &h12tiny_client_sync::http::Response<h12tiny_client_sync::ResponseBody>, name: header::HeaderName) -> Option<&str> {
    response.headers().get(name).and_then(|value| value.to_str().ok())
}

fn read_bounded(body: &mut h12tiny_client_sync::ResponseBody, deadline: Instant, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline reached"));
        }
        body.set_read_timeout(Some(remaining))?;
        let read = body.read(&mut chunk)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len() + read > limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "response exceeded its limit"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn normalize(event: OperationEvent, config: &Config) -> Option<WireEvent> {
    let event_id = event.event_id.unwrap_or_else(default_event_id);
    let at_ms = event.at_ms.unwrap_or_else(now_ms);
    if !valid_event_id(&event_id) || !valid_operation(&event.operation) || !valid_outcome(&event.outcome) {
        return None;
    }
    if at_ms == 0 || event.duration_ms > MAX_DURATION_MS {
        return None;
    }
    if event.work.len() > MAX_WORK_MEASUREMENTS || event.work.iter().any(|(key, value)| !valid_work_key(key) || *value > MAX_WORK_VALUE) {
        return None;
    }
    let instance = event.instance.or_else(|| config.instance.clone());
    if instance.as_deref().is_some_and(|text| !valid_label(text)) {
        return None;
    }
    let host = event.host.or_else(|| config.host.clone());
    if host.as_deref().is_some_and(|text| !valid_label(text)) {
        return None;
    }
    let trace = event.trace.map(|trace| WireTrace { trace_id: trace.trace_id, span_id: trace.span_id });
    if trace.as_ref().is_some_and(|trace| !valid_trace(trace)) {
        return None;
    }
    let error = event.error_code.map(|code| WireError { code });
    if error.as_ref().is_some_and(|error| !valid_error_code(&error.code) || event.outcome == SUCCESS_OUTCOME) {
        return None;
    }
    Some(WireEvent {
        delivery: None,
        schema_version: 1,
        event_id,
        at_ms,
        operation: event.operation,
        outcome: event.outcome,
        duration_ms: event.duration_ms,
        work: event.work,
        release: config.release.clone(),
        service: config.service.clone(),
        instance,
        host,
        trace,
        error,
    })
}

fn valid_service(text: &str) -> bool {
    token(text, 32, u8::is_ascii_lowercase, |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_event_id(text: &str) -> bool {
    token(text, 64, u8::is_ascii_alphanumeric, |byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_operation(text: &str) -> bool {
    token(text, 64, u8::is_ascii_lowercase, |byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_outcome(text: &str) -> bool {
    token(text, 32, u8::is_ascii_lowercase, |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-'))
}

fn valid_release(text: &str) -> bool {
    token(text, 64, u8::is_ascii_alphanumeric, |byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-'))
}

fn valid_label(text: &str) -> bool {
    token(text, 128, u8::is_ascii_alphanumeric, |byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_work_key(text: &str) -> bool {
    token(text, 32, u8::is_ascii_lowercase, |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_error_code(text: &str) -> bool {
    token(text, 64, u8::is_ascii_lowercase, |byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_trace(trace: &WireTrace) -> bool {
    hex_id(&trace.trace_id, 32) && hex_id(&trace.span_id, 16)
}

fn hex_id(text: &str, width: usize) -> bool {
    text.len() == width && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) && text.bytes().any(|byte| byte != b'0')
}

fn token(text: &str, max: usize, first: impl Fn(&u8) -> bool, rest: impl Fn(u8) -> bool) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty() && bytes.len() <= max && first(&bytes[0]) && bytes[1..].iter().copied().all(rest)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

fn default_event_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}-{:x}", nanos, COUNTER.fetch_add(1, Ordering::Relaxed), std::process::id())
}
