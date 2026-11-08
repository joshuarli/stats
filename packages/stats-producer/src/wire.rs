use deser::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_EVENTS: usize = 128;
pub const MAX_ACK_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireTrace {
    #[deser(rename = "traceId")]
    pub trace_id: String,
    #[deser(rename = "spanId")]
    pub span_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireEvent {
    #[deser(rename = "schemaVersion")]
    pub schema_version: u8,
    #[deser(rename = "eventId")]
    pub event_id: String,
    #[deser(rename = "atMs")]
    pub at_ms: u64,
    pub operation: String,
    pub outcome: String,
    #[deser(rename = "durationMs")]
    pub duration_ms: u64,
    pub work: BTreeMap<String, u64>,
    pub release: String,
    pub service: String,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub instance: Option<String>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub host: Option<String>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub trace: Option<WireTrace>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub error: Option<WireError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireBatch {
    pub events: Vec<WireEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct WireAck {
    pub accepted: u64,
    pub duplicate: u64,
}

pub fn encode_batch(batch: &WireBatch) -> Result<Vec<u8>, String> {
    deser_json::to_string(batch).map(String::into_bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
pub fn decode_batch(text: &str) -> Result<WireBatch, String> {
    deser_json::from_str(text).map_err(|error| error.to_string())
}

pub fn decode_ack(body: &[u8]) -> Option<WireAck> {
    deser_json::from_slice(body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("../../../fixtures/observe-ingest/golden.json");

    #[test]
    fn the_golden_frame_round_trips_through_the_wire_types() {
        let batch = decode_batch(GOLDEN).unwrap();
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].operation, "note.save");
        assert_eq!(batch.events[0].work.get("bytes"), Some(&1200));
        assert_eq!(encode_batch(&batch).unwrap(), GOLDEN.trim().as_bytes());
    }

    #[test]
    fn the_failing_golden_frame_round_trips_with_error_last() {
        let golden = include_str!("../../../fixtures/observe-ingest/golden-error.json");
        let batch = decode_batch(golden).unwrap();
        assert_eq!(batch.events.len(), 3);
        assert_eq!(batch.events[0].error, Some(WireError { code: "db.timeout".to_owned() }));
        assert_eq!(batch.events[2].error, None);
        assert_eq!(encode_batch(&batch).unwrap(), golden.trim().as_bytes());
    }

    #[test]
    fn optional_fields_are_omitted_and_work_is_sorted() {
        let mut event = WireEvent {
            schema_version: 1,
            event_id: "event-1".to_owned(),
            at_ms: 1,
            operation: "note.save".to_owned(),
            outcome: "ok".to_owned(),
            duration_ms: 1,
            work: BTreeMap::from([("z".to_owned(), 1), ("a".to_owned(), 2)]),
            release: "r1".to_owned(),
            service: "tansu".to_owned(),
            instance: None,
            host: None,
            trace: None,
            error: None,
        };
        let text = String::from_utf8(encode_batch(&WireBatch { events: vec![event.clone()] }).unwrap()).unwrap();
        assert_eq!(text, r#"{"events":[{"schemaVersion":1,"eventId":"event-1","atMs":1,"operation":"note.save","outcome":"ok","durationMs":1,"work":{"a":2,"z":1},"release":"r1","service":"tansu"}]}"#);
        event.work.clear();
        let text = String::from_utf8(encode_batch(&WireBatch { events: vec![event] }).unwrap()).unwrap();
        assert!(text.ends_with(r#""work":{},"release":"r1","service":"tansu"}]}"#));
    }

    #[test]
    fn an_acknowledgment_needs_both_counts() {
        assert_eq!(decode_ack(br#"{"accepted":2,"duplicate":0}"#), Some(WireAck { accepted: 2, duplicate: 0 }));
        assert_eq!(decode_ack(br#"{"accepted":2}"#), None);
        assert_eq!(decode_ack(b"not json"), None);
    }
}
