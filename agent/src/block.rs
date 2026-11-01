use crate::model::Block;
use serde::Deserialize;
use std::fs;
use std::io::Read;
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

fn read_snapshot(path: &Path) -> Option<(Block, SystemTime)> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > SNAPSHOT_LIMIT as u64 {
        return None;
    }
    if metadata.permissions().mode() & 0o022 != 0 {
        return None;
    }
    let uid = metadata.uid();
    if uid != unsafe { libc::geteuid() } && uid != 0 {
        return None;
    }
    let modified = metadata.modified().ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    if age > MAX_AGE {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(SNAPSHOT_LIMIT as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > SNAPSHOT_LIMIT {
        return None;
    }
    Some((snapshot_block(serde_json::from_slice(&bytes).ok()?)?, modified))
}

#[derive(Default)]
pub struct SnapshotReader {
    last: Option<SystemTime>,
}

impl SnapshotReader {
    pub fn read(&mut self, path: &Path) -> Option<Block> {
        let (block, modified) = read_snapshot(path)?;
        if self.last == Some(modified) {
            return None;
        }
        self.last = Some(modified);
        Some(block)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/block-tests");
        fs::create_dir_all(&root).unwrap();
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = root.join(format!("{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

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

    fn write_snapshot(path: &Path) {
        let snapshot = serde_json::to_vec(&value(buckets("1"), "1", "10", "1", "10")).unwrap();
        fs::write(path, &snapshot).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn attaches_each_snapshot_once() {
        let root = scratch();
        let path = root.join("snapshot.json");
        write_snapshot(&path);
        fs::File::options().write(true).open(&path).unwrap().set_modified(SystemTime::now() - Duration::from_secs(1)).unwrap();
        let mut reader = SnapshotReader::default();
        assert!(reader.read(&path).is_some());
        assert!(reader.read(&path).is_none());
        fs::File::options().write(true).open(&path).unwrap().set_modified(SystemTime::now() - Duration::from_secs(2)).unwrap();
        assert!(reader.read(&path).is_some());
    }

    #[test]
    fn rejects_a_stale_snapshot() {
        let root = scratch();
        let path = root.join("snapshot.json");
        write_snapshot(&path);
        fs::File::options().write(true).open(&path).unwrap().set_modified(SystemTime::now() - Duration::from_secs(31)).unwrap();
        assert!(read_snapshot(&path).is_none());
    }

    #[test]
    fn rejects_a_group_or_world_writable_snapshot() {
        let root = scratch();
        let path = root.join("snapshot.json");
        write_snapshot(&path);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read_snapshot(&path).is_none());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_snapshot(&path).is_some());
    }
}
