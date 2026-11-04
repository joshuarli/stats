use crate::model::{BootId, HostId, Sample, SystemInfo};
use crate::wire::{self, EncodeError, EncodedBatch, ACK_MEDIA_TYPE, MAX_ACK_BYTES, MAX_BODY, REQUEST_MEDIA_TYPE};
use h12tiny_client_sync::http::{header, HeaderValue, Method, Request, Uri};
use h12tiny_client_sync::{Client, ClientTlsConfigBuilder, Error as ClientError, ErrorKind};
use std::error::Error as _;
use std::fmt;
use std::io::{self, Read};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FINAL_TIMEOUT: Duration = Duration::from_secs(2);
const SYSTEM_INTERVAL: Duration = Duration::from_secs(3600);
pub const INGEST_PATH: &str = "/ingest/v2/batches";

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
    Protocol(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Retryable(message) => write!(formatter, "retryable: {message}"),
            Self::RateLimited(Some(delay)) => write!(formatter, "rate limited for {}s", delay.as_secs()),
            Self::RateLimited(None) => formatter.write_str("rate limited"),
            Self::Credential(message) => write!(formatter, "credential rejected: {message}"),
            Self::Permanent(message) => write!(formatter, "permanent: {message}"),
            Self::Protocol(message) => write!(formatter, "protocol: {message}"),
        }
    }
}

impl std::error::Error for TransportError {}

fn classify(error: &ClientError) -> TransportError {
    let mut detail = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    classify_kind(error.kind(), detail)
}

fn classify_kind(kind: ErrorKind, detail: String) -> TransportError {
    match kind {
        ErrorKind::Timeout => TransportError::Retryable("request timed out".to_owned()),
        ErrorKind::Connect => TransportError::Retryable(format!("network: {detail}")),
        ErrorKind::Tls | ErrorKind::Alpn => TransportError::Retryable(format!("TLS: {detail}")),
        ErrorKind::AbsoluteUriRequired | ErrorKind::InvalidPort | ErrorKind::UnsupportedScheme | ErrorKind::TlsUnavailable | ErrorKind::InvalidTimeout => {
            TransportError::Permanent(format!("bad request: {detail}"))
        }
        _ => TransportError::Retryable(format!("request failed: {detail}")),
    }
}

fn classify_status(status: u16, retry_after: Option<Duration>) -> TransportError {
    match status {
        400 | 404 | 413 | 422 => TransportError::Permanent(format!("server returned {status}")),
        410 | 415 => TransportError::Protocol(format!("server returned {status}: it does not accept ingest protocol v2")),
        401 | 403 => TransportError::Credential(format!("server returned {status}")),
        429 => TransportError::RateLimited(retry_after),
        _ => TransportError::Retryable(format!("server returned {status}")),
    }
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
    client: Client,
    final_client: Client,
    timeout: Duration,
    uri: Uri,
    token: Mutex<String>,
    host_id: HostId,
}

fn build_client(connect_timeout: Duration) -> Result<Client, TransportError> {
    let tls = ClientTlsConfigBuilder::new().build().map_err(|error| TransportError::Permanent(format!("system trust roots: {error}")))?;
    let builder = Client::builder().connect_timeout(connect_timeout).map_err(|error| TransportError::Permanent(format!("client: {error}")))?;
    Ok(builder.tls_config(tls).build())
}

fn header_text(response: &h12tiny_client_sync::http::Response<h12tiny_client_sync::ResponseBody>, name: header::HeaderName) -> Option<&str> {
    response.headers().get(name).and_then(|value| value.to_str().ok())
}

impl HttpTransport {
    pub fn new(endpoint: &str, host_id: &str, token: &str, timeout: Duration) -> Result<Self, TransportError> {
        let url = format!("{}{INGEST_PATH}", endpoint.trim_end_matches('/'));
        Ok(Self {
            client: build_client(timeout)?,
            final_client: build_client(timeout.min(FINAL_TIMEOUT))?,
            timeout,
            uri: url.parse().map_err(|error| TransportError::Permanent(format!("bad URL: {error}")))?,
            token: Mutex::new(token.to_owned()),
            host_id: host_id.parse().map_err(|_| TransportError::Permanent("host id is not h_ and 32 lowercase hex digits".to_owned()))?,
            system: None,
        })
    }

    pub fn announce(&mut self, info: SystemInfo) -> Result<(), String> {
        wire::check_system(&info).map_err(|field| format!("system information cannot be encoded: {field}"))?;
        self.system = Some(Mutex::new(SystemSchedule::new(info)));
        Ok(())
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

    pub fn prepare(&self, boot_id: &BootId, samples: &[Sample]) -> Result<EncodedBatch, EncodeError> {
        let system = self.due_system();
        wire::encode_batch(&self.host_id, boot_id, system.as_ref(), samples, MAX_BODY)
    }

    fn deliver_with(&self, client: &Client, timeout: Duration, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        let started = Instant::now();
        let mut authorization = HeaderValue::try_from(format!("Bearer {}", self.token())).map_err(|_| TransportError::Credential("token is not a valid header value".to_owned()))?;
        authorization.set_sensitive(true);
        let request = Request::builder()
            .method(Method::POST)
            .uri(self.uri.clone())
            .header(header::AUTHORIZATION, authorization)
            .header(header::CONTENT_TYPE, REQUEST_MEDIA_TYPE)
            .header(header::USER_AGENT, concat!("stats/", env!("CARGO_PKG_VERSION")))
            .body(batch.body.clone())
            .map_err(|error| TransportError::Permanent(format!("bad request: {error}")))?;
        let mut response = client.request_with_timeout(request, Some(timeout)).map_err(|error| classify(&error))?;
        let status = response.status().as_u16();
        if !(200..=299).contains(&status) {
            let retry_after = header_text(&response, header::RETRY_AFTER).and_then(|value| value.parse::<u64>().ok()).map(Duration::from_secs);
            return Err(classify_status(status, retry_after));
        }
        if status != 200 || header_text(&response, header::CONTENT_TYPE) != Some(ACK_MEDIA_TYPE) {
            return Err(TransportError::Protocol(format!("server returned {status} without an {ACK_MEDIA_TYPE} acknowledgment")));
        }
        let body = read_bounded(response.body_mut(), started + timeout, MAX_ACK_BYTES).map_err(|error| match error.kind() {
            io::ErrorKind::InvalidData => TransportError::Protocol("acknowledgment exceeds its bound".to_owned()),
            _ => TransportError::Retryable(format!("response body: {error}")),
        })?;
        let ack = wire::decode_ack(&body, &batch.seqs).map_err(|error| TransportError::Protocol(error.to_string()))?;
        if batch.system {
            if let Some(schedule) = &self.system {
                schedule.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).delivered(Instant::now());
            }
        }
        Ok(SendOutcome { accepted: ack.accepted, duplicates: ack.duplicates, rejected: ack.rejected.len() as u64 })
    }

    pub fn deliver(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        self.deliver_with(&self.client, self.timeout, batch)
    }

    pub fn deliver_final(&self, batch: &EncodedBatch) -> Result<SendOutcome, TransportError> {
        self.deliver_with(&self.final_client, self.timeout.min(FINAL_TIMEOUT), batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cpu, CpuInfo, Disk, DiskId, FileSystem, FileSystemType, Net};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    struct Receiver {
        endpoint: String,
        request: mpsc::Receiver<Vec<u8>>,
    }

    fn receiver(response: Vec<u8>) -> Receiver {
        receiver_delayed(response, Duration::ZERO)
    }

    fn receiver_delayed(response: Vec<u8>, delay: Duration) -> Receiver {
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
            let _ = stream.write_all(&response);
        });
        Receiver { endpoint: format!("http://{address}"), request }
    }

    fn config() -> (String, String, BootId) {
        ("h_0123456789abcdef0123456789abcdef".to_owned(), "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq".to_owned(), "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".parse().unwrap())
    }

    fn http(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn ack(accepted: u8, duplicates: u8, rejected: &[(u8, u8)]) -> Vec<u8> {
        let mut body = b"STA2\x02".to_vec();
        body.extend_from_slice(&[accepted, duplicates, rejected.len() as u8]);
        for (seq, code) in rejected {
            body.extend_from_slice(&[*seq, *code]);
        }
        http("200 OK", ACK_MEDIA_TYPE, &body)
    }

    fn sample(seq: u64) -> Sample {
        Sample { cpu: Some(Cpu { user: 1, system: 2, idle: 3, iowait: Some(4), steal: Some(5), total: 15 }), ..Sample::empty(seq, 2, 3 + seq) }
    }

    fn split(request: &[u8]) -> (String, &[u8]) {
        let index = request.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&request[..index]).to_ascii_lowercase(), &request[index + 4..])
    }

    fn send(transport: &HttpTransport, boot: &BootId, samples: &[Sample]) -> Result<SendOutcome, TransportError> {
        let batch = transport.prepare(boot, samples).unwrap();
        transport.deliver(&batch)
    }

    #[test]
    fn posts_the_encoded_frame_and_reads_partial_acceptance_from_the_binary_ack() {
        let receiver = receiver(ack(1, 0, &[(2, 1)]));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        let batch = transport.prepare(&boot, &[sample(1), sample(2)]).unwrap();
        assert_eq!(transport.deliver(&batch).unwrap(), SendOutcome { accepted: 1, duplicates: 0, rejected: 1 });
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        let (headers, body) = split(&request);
        assert!(headers.starts_with("post /ingest/v2/batches http/1.1"));
        assert!(headers.contains(&format!("authorization: bearer {token}").to_ascii_lowercase()));
        assert!(headers.contains("content-type: application/vnd.stats.ingest.v2"));
        assert_eq!(body, batch.body.as_slice());
        assert_eq!(&body[..4], b"STB2");
    }

    fn system_info() -> SystemInfo {
        SystemInfo {
            agent: "0.1.0".to_owned(),
            hostname: "threadripper".to_owned(),
            os: Some("Alpine Linux edge".to_owned()),
            kernel: "7.2.9".to_owned(),
            arch: "x86_64".to_owned(),
            cpu: CpuInfo { model: Some("AMD Ryzen 9 9950X".to_owned()), threads: 32, cores: Some(16), sockets: Some(1), max_mhz: Some(5756) },
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
        let receiver = receiver(ack(1, 0, &[]));
        let (host, token, boot) = config();
        let mut transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        transport.announce(system_info()).unwrap();
        let batch = transport.prepare(&boot, &[sample(1)]).unwrap();
        assert!(batch.system);
        assert_eq!(batch.body[5], 1);
        transport.deliver(&batch).unwrap();
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(split(&request).1.windows(12).any(|window| window == b"threadripper"));
        assert!(transport.due_system().is_none());
        assert!(!transport.prepare(&boot, &[sample(2)]).unwrap().system);

        let mut unreachable = HttpTransport::new("http://127.0.0.1:1", &host, &token, Duration::from_secs(1)).unwrap();
        unreachable.announce(system_info()).unwrap();
        assert!(send(&unreachable, &boot, &[sample(1)]).is_err());
        assert!(unreachable.due_system().is_some());
    }

    #[test]
    fn system_details_that_cannot_be_encoded_are_refused_up_front() {
        let (host, token, _) = config();
        let mut transport = HttpTransport::new("http://127.0.0.1:1", &host, &token, Duration::from_secs(1)).unwrap();
        let mut info = system_info();
        info.arch = "x".repeat(17);
        assert!(transport.announce(info).is_err());
        assert!(transport.due_system().is_none());
    }

    #[test]
    fn uses_a_replaced_token() {
        let receiver = receiver(ack(1, 0, &[]));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        let replacement = format!("nft_{}", "Z".repeat(43));
        assert!(transport.replace_token(replacement.clone()));
        assert!(!transport.replace_token(replacement.clone()));
        assert_eq!(send(&transport, &boot, &[sample(1)]).unwrap(), SendOutcome { accepted: 1, duplicates: 0, rejected: 0 });
        let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(split(&request).0.contains(&format!("authorization: bearer {}", replacement).to_ascii_lowercase()));
    }

    #[test]
    fn reports_retryable_permanent_and_protocol_statuses() {
        let (host, token, boot) = config();
        for (status, expected) in [("500 Server Error", "retryable"), ("400 Bad Request", "permanent"), ("410 Gone", "protocol"), ("415 Unsupported Media Type", "protocol")] {
            let receiver = receiver(http(status, "application/json", b"{}"));
            let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
            let error = send(&transport, &boot, &[sample(1)]).unwrap_err();
            assert!(error.to_string().starts_with(expected), "{status}: {error}");
        }
    }

    #[test]
    fn a_malformed_success_acknowledgment_is_a_protocol_failure_not_delivery() {
        let (host, token, boot) = config();
        let truncated = http("200 OK", ACK_MEDIA_TYPE, b"STA2\x02\x01");
        let json = http("200 OK", "application/json", br#"{"v":1,"accepted":1,"duplicates":0,"rejected":[]}"#);
        let overcounted = ack(2, 0, &[]);
        let unknown_seq = ack(0, 0, &[(9, 1)]);
        let unknown_code = ack(0, 0, &[(1, 7)]);
        let oversized = http("200 OK", ACK_MEDIA_TYPE, &vec![0; MAX_ACK_BYTES + 1]);
        for response in [truncated, json, overcounted, unknown_seq, unknown_code, oversized] {
            let receiver = receiver(response);
            let mut transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
            transport.announce(system_info()).unwrap();
            assert!(matches!(send(&transport, &boot, &[sample(1)]), Err(TransportError::Protocol(_))));
            assert!(transport.due_system().is_some());
        }
    }

    #[test]
    fn reports_request_timeouts_as_retryable() {
        let delayed = receiver_delayed(ack(1, 0, &[]), Duration::from_millis(300));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&delayed.endpoint, &host, &token, Duration::from_millis(50)).unwrap();
        assert!(matches!(send(&transport, &boot, &[sample(1)]), Err(TransportError::Retryable(_))));
    }

    #[test]
    fn duplicate_delivery_is_reported_not_retried() {
        let receiver = receiver(ack(0, 2, &[]));
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert_eq!(send(&transport, &boot, &[sample(1), sample(2)]).unwrap(), SendOutcome { accepted: 0, duplicates: 2, rejected: 0 });
    }

    #[test]
    fn honors_retry_after() {
        let receiver = receiver(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&receiver.endpoint, &host, &token, Duration::from_secs(2)).unwrap();
        assert_eq!(send(&transport, &boot, &[sample(1)]), Err(TransportError::RateLimited(Some(Duration::from_secs(2)))));
    }

    #[test]
    fn reports_network_and_tls_failures_without_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (host, token, boot) = config();
        let transport = HttpTransport::new(&format!("http://{address}"), &host, &token, Duration::from_millis(200)).unwrap();
        let error = send(&transport, &boot, &[sample(1)]).unwrap_err().to_string();
        assert!(!error.contains(&token));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 16];
            let _ = stream.read(&mut buffer);
        });
        let transport = HttpTransport::new(&format!("https://{address}"), &host, &token, Duration::from_millis(200)).unwrap();
        assert!(send(&transport, &boot, &[sample(1)]).is_err());
    }

    #[test]
    fn classifies_only_caller_errors_as_permanent() {
        for status in [400, 404, 413, 422] {
            assert!(matches!(classify_status(status, None), TransportError::Permanent(_)), "{status}");
        }
        for status in [410, 415] {
            assert!(matches!(classify_status(status, None), TransportError::Protocol(_)), "{status}");
        }
        for status in [401, 403] {
            assert!(matches!(classify_status(status, None), TransportError::Credential(_)), "{status}");
        }
        for status in [408, 425, 409, 418, 500, 502, 503, 504] {
            assert!(matches!(classify_status(status, None), TransportError::Retryable(_)), "{status}");
        }
        assert!(matches!(classify_status(429, Some(Duration::from_secs(2))), TransportError::RateLimited(Some(delay)) if delay == Duration::from_secs(2)));
    }

    #[test]
    fn classifies_tls_and_unclassified_errors_as_retryable() {
        assert!(matches!(classify_kind(ErrorKind::Tls, "certificate is not yet valid".to_owned()), TransportError::Retryable(_)));
        assert!(matches!(classify_kind(ErrorKind::Alpn, String::new()), TransportError::Retryable(_)));
        assert!(matches!(classify_kind(ErrorKind::Response, String::new()), TransportError::Retryable(_)));
        assert!(matches!(classify_kind(ErrorKind::AbsoluteUriRequired, "missing scheme".to_owned()), TransportError::Permanent(_)));
    }

    #[test]
    fn rejects_an_unparseable_endpoint_or_host_id() {
        let (host, token, _) = config();
        assert!(matches!(HttpTransport::new("not a url", &host, &token, Duration::from_secs(2)), Err(TransportError::Permanent(_))));
        assert!(matches!(HttpTransport::new("https://telemetry.example.com", "h_XYZ", &token, Duration::from_secs(2)), Err(TransportError::Permanent(_))));
    }

    fn large_sample(seq: u64) -> Sample {
        let disk = |index: u32| Disk { id: DiskId { major: 8, minor: index + 16 * seq as u32 }, name: format!("sd{index}"), reads: 1, read_sectors: 1, writes: 1, write_sectors: 1, io_ms: Some(1) };
        let net = |index: u64| Net { id: format!("e{seq}x{index}"), rx_bytes: 1, rx_packets: 1, rx_drops: 1, rx_errors: 1, tx_bytes: 1, tx_packets: 1, tx_drops: Some(1), tx_errors: 1 };
        let filesystem = |index: u64| FileSystem { id: format!("/mnt/{seq}/{index}/{}", "v".repeat(240)), fs_type: FileSystemType::from_name("ext4").unwrap(), total: 1, available: 1 };
        Sample { disks: Some((0..16).map(disk).collect()), nets: Some((0..16).map(net).collect()), filesystems: Some((0..16).map(filesystem).collect()), ..sample(seq) }
    }

    #[test]
    fn a_batch_over_the_body_cap_is_cut_to_the_prefix_that_fits() {
        let (host, token, boot) = config();
        let transport = HttpTransport::new("https://telemetry.example.com", &host, &token, Duration::from_secs(2)).unwrap();
        let samples: Vec<Sample> = (0..16).map(large_sample).collect();
        let batch = transport.prepare(&boot, &samples).unwrap();
        assert!(batch.body.len() <= MAX_BODY);
        assert!(batch.samples() > 1 && batch.samples() < 16, "{}", batch.samples());
        assert_eq!(batch.seqs, (0..batch.samples() as u64).collect::<Vec<_>>());
    }
}
