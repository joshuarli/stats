use crate::model::{Sample, SystemInfo};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use ureq::tls::{Certificate, RootCerts, TlsConfig, TlsProvider};

const MAX_BODY: usize = 65_536;
const MAX_RESPONSE: u64 = 16_384;
const FINAL_TIMEOUT: Duration = Duration::from_secs(2);
const SYSTEM_INTERVAL: Duration = Duration::from_secs(3600);

#[derive(Serialize)]
pub struct Batch<'a> {
    pub v: u8,
    #[serde(rename = "hostId")]
    pub host_id: &'a str,
    #[serde(rename = "bootId")]
    pub boot_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<&'a SystemInfo>,
    pub samples: &'a [Sample],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Retryable(String),
    RateLimited(Option<Duration>),
    Credential(String),
    Permanent(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Retryable(message) => write!(formatter, "retryable: {message}"),
            Self::RateLimited(Some(delay)) => write!(formatter, "rate limited for {}s", delay.as_secs()),
            Self::RateLimited(None) => formatter.write_str("rate limited"),
            Self::Credential(message) => write!(formatter, "credential rejected: {message}"),
            Self::Permanent(message) => write!(formatter, "permanent: {message}"),
        }
    }
}

impl std::error::Error for TransportError {}

#[derive(Deserialize)]
struct IngestResponse {
    v: u8,
    accepted: u64,
    duplicates: u64,
    #[serde(default)]
    rejected: Vec<serde_json::Value>,
}

pub fn encode(host_id: &str, boot_id: &str, samples: &[Sample], system: Option<&SystemInfo>) -> Result<Vec<u8>, TransportError> {
    if samples.is_empty() {
        return Err(TransportError::Permanent("empty batch".to_owned()));
    }
    if samples.len() > 16 {
        return Err(TransportError::Permanent("batch exceeds 16 samples".to_owned()));
    }
    let body = serde_json::to_vec(&Batch { v: 1, host_id, boot_id, system, samples }).map_err(|error| TransportError::Permanent(format!("encode: {error}")))?;
    if body.len() > MAX_BODY {
        return Err(TransportError::Permanent(format!("batch is {} bytes, over the {} byte cap", body.len(), MAX_BODY)));
    }
    Ok(body)
}

fn tls_config() -> Result<TlsConfig, TransportError> {
    let native = rustls_native_certs::load_native_certs();
    if native.certs.is_empty() {
        return Err(TransportError::Permanent("no system trust roots are available".to_owned()));
    }
    let certs: Vec<Certificate<'static>> = native.certs.iter().map(|cert| Certificate::from_der(cert.as_ref()).to_owned()).collect();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(TlsConfig::builder()
        .provider(TlsProvider::Rustls)
        .unversioned_rustls_crypto_provider(provider)
        .root_certs(RootCerts::from(certs))
        .build())
}

fn parse_response(body: &[u8]) -> Result<SendOutcome, TransportError> {
    let response: IngestResponse = serde_json::from_slice(body).map_err(|error| TransportError::Retryable(format!("invalid ingest response: {error}")))?;
    if response.v != 1 {
        return Err(TransportError::Retryable("unknown ingest response version".to_owned()));
    }
    Ok(SendOutcome {
        accepted: response.accepted,
        duplicates: response.duplicates,
        rejected: response.rejected.len() as u64,
    })
}

fn classify(error: ureq::Error) -> TransportError {
    match error {
        ureq::Error::StatusCode(status) => classify_status(status, None),
        ureq::Error::Timeout(_) => TransportError::Retryable("request timed out".to_owned()),
        ureq::Error::Io(error) => TransportError::Retryable(format!("network: {error}")),
        ureq::Error::HostNotFound => TransportError::Retryable("host not found".to_owned()),
        ureq::Error::ConnectionFailed => TransportError::Retryable("connection failed".to_owned()),
        ureq::Error::Protocol(error) => TransportError::Retryable(format!("protocol: {error}")),
        ureq::Error::Tls(message) => TransportError::Retryable(format!("TLS: {message}")),
        ureq::Error::Rustls(error) => TransportError::Retryable(format!("TLS: {error}")),
        ureq::Error::BadUri(message) => TransportError::Permanent(format!("bad URL: {message}")),
        ureq::Error::Http(error) => TransportError::Retryable(format!("HTTP: {error}")),
        ureq::Error::BodyExceedsLimit(_) => TransportError::Permanent("request body exceeded its limit".to_owned()),
        other => TransportError::Retryable(format!("request failed: {other}")),
    }
}

fn classify_status(status: u16, retry_after: Option<Duration>) -> TransportError {
    match status {
        400 | 404 | 413 | 422 => TransportError::Permanent(format!("server returned {status}")),
        401 | 403 => TransportError::Credential(format!("server returned {status}")),
        429 => TransportError::RateLimited(retry_after),
        _ => TransportError::Retryable(format!("server returned {status}")),
    }
}

pub struct SystemSchedule {
    info: SystemInfo,
    sent_at: Option<Instant>,
}

impl SystemSchedule {
    pub fn new(info: SystemInfo) -> Self {
        Self { info, sent_at: None }
    }

    pub fn due(&self, now: Instant) -> Option<&SystemInfo> {
        match self.sent_at {
            Some(sent) if now.saturating_duration_since(sent) < SYSTEM_INTERVAL => None,
            _ => Some(&self.info),
        }
    }

    pub fn delivered(&mut self, now: Instant) {
        self.sent_at = Some(now);
    }
}

pub struct HttpTransport {
    system: Option<Mutex<SystemSchedule>>,
    agent: ureq::Agent,
    final_agent: ureq::Agent,
    url: String,
    token: Mutex<String>,
    host_id: String,
}

fn build_agent(timeout: Duration) -> Result<ureq::Agent, TransportError> {
    let tls = tls_config()?;
    Ok(ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(timeout))
        .user_agent(concat!("stats/", env!("CARGO_PKG_VERSION")))
        .tls_config(tls)
        .build()
        .into())
}

impl HttpTransport {
    pub fn new(endpoint: &str, host_id: &str, token: &str, timeout: Duration) -> Result<Self, TransportError> {
        Ok(Self {
            agent: build_agent(timeout)?,
            final_agent: build_agent(timeout.min(FINAL_TIMEOUT))?,
            url: format!("{}/ingest/v1/batches", endpoint.trim_end_matches('/')),
            token: Mutex::new(token.to_owned()),
            host_id: host_id.to_owned(),
            system: None,
        })
    }

    pub fn announcing(mut self, info: SystemInfo) -> Self {
        self.system = Some(Mutex::new(SystemSchedule::new(info)));
        self
    }

    fn due_system(&self) -> Option<SystemInfo> {
        let schedule = self.system.as_ref()?.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        schedule.due(Instant::now()).cloned()
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub fn replace_token(&self, token: String) -> bool {
        let mut current = self.token.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == token {
            return false;
        }
        *current = token;
        true
    }

    pub fn fits(&self, boot_id: &str, samples: &[Sample]) -> bool {
        let system = self.system.as_ref().map(|schedule| schedule.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).info.clone());
        encode(&self.host_id, boot_id, samples, system.as_ref()).is_ok()
    }

    fn send_with(&self, agent: &ureq::Agent, boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
        let system = self.due_system();
        let body = encode(&self.host_id, boot_id, samples, system.as_ref())?;
        let mut response = match agent
            .post(&self.url)
            .header("Authorization", format!("Bearer {}", self.token()))
            .header("Content-Type", "application/json")
            .send(body.as_slice())
        {
            Ok(response) => response,
            Err(error) => return Err(classify(error)),
        };
        let status = response.status().as_u16();
        if !(200..=299).contains(&status) {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(classify_status(status, retry_after));
        }
        let body = response.body_mut().with_config().limit(MAX_RESPONSE).read_to_vec().map_err(|error| TransportError::Retryable(format!("response body: {error}")))?;
        let outcome = parse_response(&body)?;
        if system.is_some() {
            if let Some(schedule) = &self.system {
                schedule.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).delivered(Instant::now());
            }
        }
        Ok(outcome)
    }

    pub fn send(&self, boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
        self.send_with(&self.agent, boot_id, samples)
    }

    pub fn send_final(&self, boot_id: &str, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
        self.send_with(&self.final_agent, boot_id, samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    struct Receiver {
        endpoint: String,
        request: mpsc::Receiver<Vec<u8>>,
    }

    fn receiver(response: &'static [u8]) -> Receiver {
        receiver_delayed(response, Duration::ZERO)
    }

    fn receiver_delayed(response: &'static [u8], delay: Duration) -> Receiver {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, request) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut data = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..read]);
                if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..index + 4]).to_ascii_lowercase();
                    let length = headers.lines().find_map(|line| line.strip_prefix("content-length:")).and_then(|value| value.trim().parse::<usize>().ok()).unwrap_or(0);
                    while data.len() < index + 4 + length {
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        data.extend_from_slice(&buffer[..read]);
                    }
                    break;
                }
            }
            sender.send(data).unwrap();
            let _ = stream.write_all(response);
        });
        Receiver { endpoint: format!("http://{address}"), request }
    }

    fn config() -> (String, String, String) {
        ("h_0123456789abcdef0123456789abcdef".to_owned(), "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq".to_owned(), "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".to_owned())
    }

    fn response(accepted: u64, duplicates: u64, rejected: &str) -> &'static [u8] {
        body_response(&format!(r#"{{"v":1,"accepted":{accepted},"duplicates":{duplicates},"rejected":{rejected}}}"#))
    }

    fn body_response(body: &str) -> &'static [u8] {
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        Box::leak(response.into_bytes().into_boxed_slice())
    }

    fn sample() -> Sample {
        Sample {
            cpu: Some(crate::model::Cpu {
                user: "1".into(),
                system: "2".into(),
                idle: "3".into(),
                iowait: "4".into(),
                steal: "5".into(),
                total: "15".into(),
            }),
            ..Sample::empty(1, 2, 3)
        }
    }

    #[test]
    fn sends_the_batch_and_parses_partial_acceptance() {
        let response = response(1, 0, r#"[{"seq":"2","code":"invalid_sample"}]"#);
        let receiver = receiver(response);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        let outcome = transport.send(&boot, &[sample()]).unwrap();
        assert_eq!(outcome, SendOutcome { accepted: 1, duplicates: 0, rejected: 1 });
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        let text = String::from_utf8_lossy(&request);
        assert!(text.starts_with("POST /ingest/v1/batches HTTP/1.1"));
        assert!(text.to_ascii_lowercase().contains(&format!("authorization: bearer {token}").to_ascii_lowercase()));
        let payload: serde_json::Value = serde_json::from_slice(&request[request.windows(4).position(|window| window == b"\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(payload["bootId"], boot);
        assert_eq!(payload["hostId"], host);
        assert_eq!(payload["samples"][0]["seq"], "1");
    }

    fn system_info() -> SystemInfo {
        SystemInfo {
            agent: "0.1.0".to_owned(),
            hostname: "threadripper".to_owned(),
            os: Some("Alpine Linux edge".to_owned()),
            kernel: "7.2.9".to_owned(),
            arch: "x86_64".to_owned(),
            cpu: crate::model::CpuInfo { model: Some("AMD Ryzen 9 9950X".to_owned()), threads: 32, cores: Some(16), sockets: Some(1), max_mhz: Some(5756) },
        }
    }

    #[test]
    fn system_details_ride_along_until_delivered_and_then_once_an_hour() {
        let start = Instant::now();
        let mut schedule = SystemSchedule::new(system_info());
        assert!(schedule.due(start).is_some());
        assert!(schedule.due(start + Duration::from_secs(5)).is_some());
        schedule.delivered(start);
        assert!(schedule.due(start + Duration::from_secs(3599)).is_none());
        assert!(schedule.due(start + Duration::from_secs(3600)).is_some());
    }

    #[test]
    fn the_first_batch_announces_the_system_and_a_failed_one_does_not_count() {
        let receiver = receiver(response(1, 0, "[]"));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap().announcing(system_info());
        transport.send(&boot, &[sample()]).unwrap();
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&request[request.windows(4).position(|window| window == b"\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(payload["system"]["hostname"], "threadripper");
        assert_eq!(payload["system"]["cpu"]["cores"], 16);
        assert_eq!(payload["system"]["cpu"]["maxMhz"], 5756);
        assert!(transport.due_system().is_none());

        let unreachable = HttpTransport::new("http://127.0.0.1:1", &host, &token, Duration::from_secs(1)).unwrap().announcing(system_info());
        assert!(unreachable.send(&boot, &[sample()]).is_err());
        assert!(unreachable.due_system().is_some());
    }

    #[test]
    fn uses_a_replaced_token() {
        let response = response(1, 0, "[]");
        let receiver = receiver(response);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        let replacement = format!("nft_{}", "Z".repeat(43));
        assert!(transport.replace_token(replacement.clone()));
        assert!(!transport.replace_token(replacement.clone()));
        assert_eq!(transport.send(&boot, &[sample()]).unwrap(), SendOutcome { accepted: 1, duplicates: 0, rejected: 0 });
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
        assert!(text.contains(&format!("authorization: bearer {}", replacement).to_ascii_lowercase()));
    }

    #[test]
    fn reports_retryable_and_permanent_statuses() {
        let retryable = receiver(b"HTTP/1.1 500 Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&retryable.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert!(matches!(transport.send(&boot, &[sample()]), Err(TransportError::Retryable(_))));
        let permanent = receiver(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let transport = HttpTransport::new(&permanent.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert!(matches!(transport.send(&boot, &[sample()]), Err(TransportError::Permanent(_))));
    }

    #[test]
    fn reports_request_timeouts_as_retryable() {
        let delayed = receiver_delayed(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", Duration::from_millis(300));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&delayed.endpoint, &host, &token, Duration::from_millis(50)).unwrap();
        assert!(matches!(transport.send(&boot, &[sample()]), Err(TransportError::Retryable(_))));
    }

    #[test]
    fn duplicate_delivery_is_reported_not_retried() {
        let response = response(0, 2, "[]");
        let receiver = receiver(response);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert_eq!(transport.send(&boot, &[sample()]).unwrap(), SendOutcome { accepted: 0, duplicates: 2, rejected: 0 });
    }

    #[test]
    fn honors_retry_after() {
        let receiver = receiver(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert_eq!(transport.send(&boot, &[sample()]), Err(TransportError::RateLimited(Some(Duration::from_secs(2)))));
    }

    #[test]
    fn reports_network_and_tls_failures_without_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&format!("http://{address}"), &host, &token, Duration::from_millis(200)).unwrap();
        let error = transport.send(&boot, &[sample()]).unwrap_err().to_string();
        assert!(!error.contains(&token));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 16];
            let _ = stream.read(&mut buffer);
        });
        let transport = HttpTransport::new(&format!("https://{address}"), &host, &token, Duration::from_millis(200)).unwrap();
        assert!(transport.send(&boot, &[sample()]).is_err());
    }

    #[test]
    fn classifies_only_caller_errors_as_permanent() {
        for status in [400, 404, 413, 422] {
            assert!(matches!(classify_status(status, None), TransportError::Permanent(_)), "{status}");
        }
        for status in [401, 403] {
            assert!(matches!(classify_status(status, None), TransportError::Credential(_)), "{status}");
        }
        for status in [408, 425, 409, 410, 418, 500, 502, 503, 504] {
            assert!(matches!(classify_status(status, None), TransportError::Retryable(_)), "{status}");
        }
        assert!(matches!(classify_status(429, Some(Duration::from_secs(2))), TransportError::RateLimited(Some(delay)) if delay == Duration::from_secs(2)));
    }

    #[test]
    fn classifies_tls_and_unclassified_errors_as_retryable() {
        assert!(matches!(classify(ureq::Error::Tls("certificate is not yet valid")), TransportError::Retryable(_)));
        assert!(matches!(classify(ureq::Error::Rustls(rustls::Error::General("certificate is not yet valid".to_owned()))), TransportError::Retryable(_)));
        assert!(matches!(classify(ureq::Error::RedirectFailed), TransportError::Retryable(_)));
        assert!(matches!(classify(ureq::Error::BadUri("missing scheme".to_owned())), TransportError::Permanent(_)));
        assert!(matches!(classify(ureq::Error::BodyExceedsLimit(1)), TransportError::Permanent(_)));
    }

    #[test]
    fn accepts_an_additive_response_field() {
        let response = body_response(r#"{"v":1,"accepted":1,"duplicates":0,"rejected":[],"future":true}"#);
        let receiver = receiver(response);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert_eq!(transport.send(&boot, &[sample()]).unwrap(), SendOutcome { accepted: 1, duplicates: 0, rejected: 0 });
    }

    fn large_sample() -> Sample {
        let disk = |index: usize| crate::model::Disk {
            id: format!("8:{index}"),
            name: format!("sd{index}"),
            reads: "1".into(),
            read_sectors: "1".into(),
            writes: "1".into(),
            write_sectors: "1".into(),
            io_ms: "1".into(),
        };
        let net = |index: usize| crate::model::Net {
            id: format!("eth{index}"),
            rx_bytes: "1".into(),
            rx_packets: "1".into(),
            rx_drops: "1".into(),
            rx_errors: "1".into(),
            tx_bytes: "1".into(),
            tx_packets: "1".into(),
            tx_drops: "1".into(),
            tx_errors: "1".into(),
        };
        let filesystem = |index: usize| crate::model::FileSystem { id: format!("/mnt/volume-{index}"), fs_type: "ext4".into(), total: "1".into(), available: "1".into() };
        Sample {
            disks: Some((0..16).map(disk).collect()),
            nets: Some((0..16).map(net).collect()),
            filesystems: Some((0..16).map(filesystem).collect()),
            ..sample()
        }
    }

    #[test]
    fn rejects_empty_and_oversized_batches() {
        assert!(matches!(encode("h_0123456789abcdef0123456789abcdef", "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", &[], None), Err(TransportError::Permanent(_))));
        let huge = vec![sample(); 64];
        assert!(matches!(encode("h_0123456789abcdef0123456789abcdef", "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", &huge, None), Err(TransportError::Permanent(_))));
    }

    #[test]
    fn a_batch_over_the_body_cap_does_not_fit() {
        let (host, token, boot) = config();
        let transport = HttpTransport::new("https://telemetry.example.com", &host, &token, Duration::from_secs(2)).unwrap();
        let samples = vec![large_sample(); 16];
        assert!(!transport.fits(&boot, &samples));
        assert!(transport.fits(&boot, &samples[..1]));
    }
}
