use stats_producer::{OperationEvent, Producer, ProducerConfig, ProducerStats};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

struct Receiver {
    endpoint: String,
    request: mpsc::Receiver<Vec<u8>>,
}

fn read_request(stream: &mut TcpStream) -> Vec<u8> {
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
    data
}

fn receiver_with(responses: Vec<Vec<u8>>, on_request: impl Fn(usize) + Send + 'static) -> Receiver {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, request) = mpsc::channel();
    thread::spawn(move || {
        for (index, response) in responses.into_iter().enumerate() {
            let (mut stream, _) = listener.accept().unwrap();
            let data = read_request(&mut stream);
            on_request(index);
            sender.send(data).unwrap();
            let _ = stream.write_all(&response);
        }
    });
    Receiver { endpoint: format!("http://{address}"), request }
}

fn receiver(responses: Vec<Vec<u8>>) -> Receiver {
    receiver_with(responses, |_| {})
}

fn hanging() -> Receiver {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, request) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let data = read_request(&mut stream);
        sender.send(data).unwrap();
        thread::sleep(Duration::from_millis(200));
    });
    Receiver { endpoint: format!("http://{address}"), request }
}

fn response(status: &str, body: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

fn split(request: &[u8]) -> (String, String) {
    let index = request.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
    (String::from_utf8_lossy(&request[..index + 4]).to_ascii_lowercase(), String::from_utf8_lossy(&request[index + 4..]).into_owned())
}

fn config(endpoint: &str) -> ProducerConfig {
    let mut config = ProducerConfig::new(endpoint, "tansu", "ingest-token", "9df651c1a2b3");
    config.flush_interval = Duration::from_secs(60);
    config.timeout = Duration::from_secs(2);
    config.max_retries = 0;
    config.backoff_base = Duration::from_millis(1);
    config.max_retry_after = Duration::from_secs(5);
    config
}

fn event(operation: &str, bytes: u64) -> OperationEvent {
    let mut event = OperationEvent::new(operation, "ok", 1);
    event.work.insert("bytes".to_owned(), bytes);
    event
}

fn zeros() -> ProducerStats {
    ProducerStats { queued: 0, dropped: 0, sent: 0, duplicates: 0, batches: 0, retries: 0, last_error: None }
}

#[test]
fn sends_a_batch_and_reads_the_ack() {
    let receiver = receiver(vec![response("202 Accepted", r#"{"accepted":2,"duplicate":0}"#)]);
    let producer = Producer::new(config(&receiver.endpoint)).unwrap();
    producer.record(event("note.save", 1));
    producer.record(event("note.search", 2));
    producer.flush().unwrap();
    let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
    let (headers, body) = split(&request);
    assert!(headers.starts_with("post /ingest/observe/v1/tansu/batches http/1.1"), "{headers}");
    assert!(headers.contains("authorization: bearer ingest-token"), "{headers}");
    assert!(headers.contains("content-type: application/json"), "{headers}");
    assert!(body.contains(r#""operation":"note.save""#), "{body}");
    assert!(body.contains(r#""operation":"note.search""#), "{body}");
    let stats = producer.stats();
    assert_eq!(stats.sent, 2);
    assert_eq!(stats.batches, 1);
    assert_eq!(stats.dropped, 0);
    assert_eq!(stats.last_error, None);
    producer.shutdown().unwrap();
}

#[test]
fn a_timeout_is_dropped_after_the_retry_budget() {
    let receiver = hanging();
    let mut config = config(&receiver.endpoint);
    config.timeout = Duration::from_millis(20);
    let producer = Producer::new(config).unwrap();
    producer.record(event("note.save", 1));
    producer.flush().unwrap();
    let stats = producer.stats();
    assert_eq!(stats.dropped, 1);
    assert_eq!(stats.last_error.as_deref(), Some("timeout_or_network"));
    receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
}

#[test]
fn a_malformed_success_body_is_retried_and_then_dropped() {
    let receiver = receiver(vec![response("200 OK", "not json"), response("200 OK", "not json")]);
    let mut config = config(&receiver.endpoint);
    config.max_retries = 1;
    let producer = Producer::new(config).unwrap();
    producer.record(event("note.save", 1));
    producer.flush().unwrap();
    let stats = producer.stats();
    assert_eq!(stats.dropped, 1);
    assert_eq!(stats.last_error.as_deref(), Some("malformed_response"));
    assert_eq!(stats.retries, 1);
    assert!(receiver.request.recv_timeout(Duration::from_secs(2)).is_ok());
    assert!(receiver.request.recv_timeout(Duration::from_secs(2)).is_ok());
}

#[test]
fn a_retryable_status_is_retried_and_then_accepted() {
    let receiver = receiver(vec![
        response("503 Service Unavailable", "{}"),
        response("202 Accepted", r#"{"accepted":1,"duplicate":0}"#),
    ]);
    let mut config = config(&receiver.endpoint);
    config.max_retries = 2;
    let producer = Producer::new(config).unwrap();
    producer.record(event("note.save", 1));
    producer.flush().unwrap();
    let stats = producer.stats();
    assert_eq!(stats.sent, 1);
    assert_eq!(stats.retries, 1);
    assert_eq!(stats.dropped, 0);
    assert!(receiver.request.recv_timeout(Duration::from_secs(2)).is_ok());
    assert!(receiver.request.recv_timeout(Duration::from_secs(2)).is_ok());
}

#[test]
fn queue_overflow_drops_the_oldest_event() {
    let receiver = receiver(vec![response("202 Accepted", r#"{"accepted":2,"duplicate":0}"#)]);
    let mut config = config(&receiver.endpoint);
    config.queue_limit = 2;
    config.batch_size = 128;
    let producer = Producer::new(config).unwrap();
    producer.record(event("note.save", 1));
    producer.record(event("note.save", 2));
    producer.record(event("note.save", 3));
    assert_eq!(producer.stats().dropped, 1);
    producer.flush().unwrap();
    let request = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
    let body = split(&request).1;
    assert!(!body.contains(r#""bytes":1"#), "{body}");
    assert!(body.contains(r#""bytes":2"#), "{body}");
    assert!(body.contains(r#""bytes":3"#), "{body}");
}

#[test]
fn shutdown_flushes_and_then_refuses_new_events() {
    let receiver = receiver(vec![response("202 Accepted", r#"{"accepted":1,"duplicate":0}"#)]);
    let producer = Producer::new(config(&receiver.endpoint)).unwrap();
    producer.record(event("note.save", 1));
    producer.shutdown().unwrap();
    assert!(receiver.request.recv_timeout(Duration::from_secs(2)).is_ok());
    producer.record(event("note.save", 2));
    let stats = producer.stats();
    assert_eq!(stats.dropped, 1);
    assert_eq!(stats.last_error.as_deref(), Some("closed"));
}

#[test]
fn a_rotated_token_is_used_on_the_retry() {
    let holder: Arc<Mutex<Option<Arc<Producer>>>> = Arc::new(Mutex::new(None));
    let rotated = Arc::clone(&holder);
    let receiver = receiver_with(
        vec![response("401 Unauthorized", "{}"), response("202 Accepted", r#"{"accepted":1,"duplicate":0}"#)],
        move |index| {
            if index == 0 {
                if let Some(producer) = rotated.lock().unwrap().as_ref() {
                    producer.replace_token("new-token".to_owned());
                }
            }
        },
    );
    let mut settings = config(&receiver.endpoint);
    settings.max_retries = 1;
    let producer = Arc::new(Producer::new(settings).unwrap());
    *holder.lock().unwrap() = Some(Arc::clone(&producer));
    producer.record(event("note.save", 1));
    producer.flush().unwrap();
    let first = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
    let second = receiver.request.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(split(&first).0.contains("authorization: bearer ingest-token"));
    assert!(split(&second).0.contains("authorization: bearer new-token"));
    let stats = producer.stats();
    assert_eq!(stats.sent, 1);
    assert_eq!(stats.retries, 1);
    assert_eq!(stats.dropped, 0);
}

#[test]
fn an_unconfigured_producer_is_a_no_op() {
    let producer = Producer::new(ProducerConfig::default()).unwrap();
    producer.record(event("note.save", 1));
    producer.flush().unwrap();
    assert_eq!(producer.stats(), zeros());
    producer.shutdown().unwrap();
    assert_eq!(producer.stats(), zeros());
}
