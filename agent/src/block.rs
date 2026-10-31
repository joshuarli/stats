use crate::model::Block;
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub const BUCKETS: usize = 16;
const SNAPSHOT_LIMIT: usize = 4_096;
const MAX_AGE: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    v: u32,
    buckets: Vec<String>,
    count: String,
    #[serde(rename = "totalUs")]
    total_us: String,
    #[serde(rename = "minUs")]
    min_us: String,
    #[serde(rename = "maxUs")]
    max_us: String,
}

fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) || (value.len() > 1 && value.starts_with('0')) {
        return None;
    }
    value.parse().ok()
}

fn snapshot_block(snapshot: Snapshot) -> Option<Block> {
    if snapshot.v != 1 || snapshot.buckets.len() != BUCKETS {
        return None;
    }
    let mut buckets = Vec::with_capacity(BUCKETS);
    let mut sum = 0_u64;
    for value in snapshot.buckets {
        let count = decimal(&value)?;
        sum = sum.checked_add(count)?;
        buckets.push(count.to_string());
    }
    let count = decimal(&snapshot.count)?;
    let total_us = decimal(&snapshot.total_us)?;
    let min_us = decimal(&snapshot.min_us)?;
    let max_us = decimal(&snapshot.max_us)?;
    if count != sum {
        return None;
    }
    if count == 0 {
        if total_us != 0 || min_us != 0 || max_us != 0 {
            return None;
        }
    } else if min_us > max_us || max_us > total_us {
        return None;
    }
    Some(Block {
        buckets,
        count: count.to_string(),
        total_us: total_us.to_string(),
        min_us: min_us.to_string(),
        max_us: max_us.to_string(),
    })
}

pub fn read(path: &Path) -> Option<Block> {
    let link = fs::symlink_metadata(path).ok()?;
    if link.file_type().is_symlink() || !link.is_file() || link.len() > SNAPSHOT_LIMIT as u64 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if link.permissions().mode() & 0o022 != 0 {
            return None;
        }
    }
    let age = SystemTime::now().duration_since(link.modified().ok()?).ok()?;
    if age > MAX_AGE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() > SNAPSHOT_LIMIT {
        return None;
    }
    snapshot_block(serde_json::from_slice(&bytes).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(buckets: Vec<&str>, count: &str, total: &str, min: &str, max: &str) -> serde_json::Value {
        json!({ "v": 1, "buckets": buckets, "count": count, "totalUs": total, "minUs": min, "maxUs": max })
    }

    fn parse(value: serde_json::Value) -> Option<Block> {
        snapshot_block(serde_json::from_value(value).ok()?)
    }

    fn buckets(first: &str) -> Vec<&str> {
        let mut values = vec!["0"; BUCKETS];
        values[0] = first;
        values
    }

    #[test]
    fn accepts_a_consistent_snapshot() {
        let block = parse(value(buckets("3"), "3", "900", "100", "400")).unwrap();
        assert_eq!(block.count, "3");
        assert_eq!(block.total_us, "900");
        assert_eq!(block.buckets[0], "3");
    }

    #[test]
    fn rejects_inconsistent_snapshots() {
        assert!(parse(value(buckets("3"), "2", "900", "100", "400")).is_none());
        assert!(parse(value(buckets("0"), "0", "1", "0", "0")).is_none());
        assert!(parse(value(buckets("1"), "1", "50", "100", "40")).is_none());
        assert!(parse(value(buckets("1"), "1", "50", "100", "100")).is_none());
        assert!(parse(value(vec!["0"; 15], "0", "0", "0", "0")).is_none());
        assert!(parse(json!({ "v": 2, "buckets": buckets("0"), "count": "0", "totalUs": "0", "minUs": "0", "maxUs": "0" })).is_none());
        assert!(parse(json!({ "v": 1, "buckets": buckets("0"), "count": "0", "totalUs": "0", "minUs": "0" })).is_none());
    }

    #[test]
    fn rejects_noncanonical_decimals() {
        assert!(parse(value(buckets("01"), "1", "10", "1", "10")).is_none());
        assert!(parse(value(buckets("+1"), "1", "10", "1", "10")).is_none());
        assert!(parse(value(buckets("-1"), "1", "10", "1", "10")).is_none());
    }
}
