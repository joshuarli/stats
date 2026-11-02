use stats::model::{Cpu, Disk, FileSystem, Net, PsiGroup, Sample, Unavailable};
use stats::parse::FILESYSTEM_TYPES;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    TooLarge,
    InvalidJson,
    UnknownVersion,
    InvalidBatch,
    InvalidSample,
}

impl Failure {
    fn code(&self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::InvalidJson => "invalid_json",
            Self::UnknownVersion => "unknown_version",
            Self::InvalidBatch => "invalid_batch",
            Self::InvalidSample => "invalid_sample",
        }
    }
}

const SAMPLE_KEYS: [&str; 14] = ["seq", "atMs", "monoMs", "unavailable", "cpu", "load", "mem", "uptimeMs", "cpuCount", "disks", "nets", "psi", "filesystems", "block"];
const UNAVAILABLE: [&str; 8] = ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems"];

fn u64_value(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse::<u64>().ok()
}

fn decimal(value: &Value) -> bool {
    u64_value(value).is_some()
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn timestamp(value: &Value) -> bool {
    u64_value(value).is_some_and(|value| value <= MAX_SAFE)
}

fn fixed(value: &Value, fraction: usize) -> bool {
    let Some(text) = value.as_str() else { return false };
    let Some((whole, tail)) = text.split_once('.') else { return false };
    !whole.is_empty()
        && whole.len() <= 6
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && tail.len() == fraction
        && tail.bytes().all(|byte| byte.is_ascii_digit())
}

fn object(value: &Value, keys: &[&str]) -> bool {
    let Some(map) = value.as_object() else { return false };
    map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}

fn u64_map(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.keys().all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
            && required.iter().all(|key| map.contains_key(*key))
            && map.values().all(decimal)
    })
}

fn id(value: &Value, valid: impl Fn(&str) -> bool) -> bool {
    value.as_str().is_some_and(valid)
}

fn bounded_decimal(text: &str, digits: usize, max: u32) -> bool {
    !text.is_empty() && text.len() <= digits && text.bytes().all(|byte| byte.is_ascii_digit()) && text.parse::<u32>().is_ok_and(|value| value <= max)
}

fn valid_disk_id(text: &str) -> bool {
    let Some((major, minor)) = text.split_once(':') else { return false };
    bounded_decimal(major, 4, 4_095) && bounded_decimal(minor, 7, 1_048_575)
}

fn valid_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 32 && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_ifname(text: &str) -> bool {
    !text.is_empty() && text.len() <= 15 && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-'))
}

fn valid_host(text: &str) -> bool {
    text.len() == 34 && text.starts_with("h_") && text[2..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_boot(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_digit() || ('a'..='f').contains(&character),
        })
}

fn validate_block(value: &Value) -> bool {
    if !object(value, &["buckets", "count", "totalUs", "minUs", "maxUs"]) {
        return false;
    }
    let Some(buckets) = value["buckets"].as_array() else { return false };
    if buckets.len() != 16 {
        return false;
    }
    let Some(counts) = buckets.iter().map(u64_value).collect::<Option<Vec<u64>>>() else { return false };
    let Some(count) = u64_value(&value["count"]) else { return false };
    let Some(total) = u64_value(&value["totalUs"]) else { return false };
    let Some(min) = u64_value(&value["minUs"]) else { return false };
    let Some(max) = u64_value(&value["maxUs"]) else { return false };
    let sum: u128 = counts.iter().map(|value| *value as u128).sum();
    if sum != count as u128 {
        return false;
    }
    if count == 0 {
        total == 0 && min == 0 && max == 0
    } else {
        min <= max && max <= total
    }
}

fn validate_group(sample: &Value, key: &str) -> bool {
    let value = &sample[key];
    match key {
        "cpu" => u64_map(value, &["user", "system", "idle", "total"], &["iowait", "steal"]),
        "load" => object(value, &["one", "five", "fifteen"]) && ["one", "five", "fifteen"].iter().all(|field| fixed(&value[*field], 3)),
        "mem" => {
            let required = ["total", "available", "swapTotal", "swapFree"];
            let activity = ["swapIn", "swapOut"];
            let present = activity.iter().filter(|key| value.get(**key).is_some()).count();
            keys(value, &["total", "available", "swapTotal", "swapFree", "swapIn", "swapOut", "pressure"])
                && required.iter().all(|key| decimal(&value[*key]))
                && value.get("pressure").is_none_or(|level| ["normal", "warn", "critical"].iter().any(|name| level == name))
                && (present == 0 || (present == 2 && activity.iter().all(|key| decimal(&value[*key]))))
        }
        "uptimeMs" => decimal(value),
        "cpuCount" => value.as_u64().is_some_and(|count| (1..=4096).contains(&count)),
        "disks" => {
            value.as_array().is_some_and(|devices| {
                devices.len() <= 16
                    && devices.iter().enumerate().all(|(index, device)| {
                        id(&device["id"], valid_disk_id)
                            && id(&device["name"], valid_name)
                            && device.as_object().is_some_and(|map| {
                                let counters: serde_json::Map<String, Value> = map.iter().filter(|(key, _)| *key != "id" && *key != "name").map(|(key, value)| (key.clone(), value.clone())).collect();
                                u64_map(&Value::Object(counters), &["reads", "readSectors", "writes", "writeSectors"], &["ioMs"])
                            })
                            && devices[..index].iter().all(|other| other["id"] != device["id"])
                    })
            })
        }
        "nets" => {
            value.as_array().is_some_and(|interfaces| {
                interfaces.len() <= 16
                    && interfaces.iter().enumerate().all(|(index, interface)| {
                        id(&interface["id"], valid_ifname)
                            && interface.as_object().is_some_and(|map| {
                                let counters: serde_json::Map<String, Value> = map.iter().filter(|(key, _)| *key != "id").map(|(key, value)| (key.clone(), value.clone())).collect();
                                u64_map(&Value::Object(counters), &["rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txErrors"], &["txDrops"])
                            })
                            && interfaces[..index].iter().all(|other| other["id"] != interface["id"])
                    })
            })
        }
        "psi" => {
            keys(value, &["cpu", "memory", "io"])
                && value.as_object().is_some_and(|map| !map.is_empty())
                && value.as_object().is_some_and(|map| map.values().all(|group| {
                    keys(group, &["some10", "some60", "some300", "total", "full10", "full60", "full300", "fullTotal"])
                        && ["some10", "some60", "some300"].iter().all(|field| fixed(&group[*field], 2))
                        && decimal(&group["total"])
                        && ["full10", "full60", "full300"].iter().all(|field| group.get(*field).is_none_or(|value| fixed(value, 2)))
                        && group.get("fullTotal").is_none_or(decimal)
                }))
        }
        "filesystems" => {
            value.as_array().is_some_and(|filesystems| {
                filesystems.len() <= 16
                    && filesystems.iter().enumerate().all(|(index, filesystem)| {
                        object(filesystem, &["id", "type", "total", "available"])
                            && id(&filesystem["id"], |text| text.starts_with('/') && text.len() <= 255 && !text.contains('\0'))
                            && filesystem["type"].as_str().is_some_and(|kind| FILESYSTEM_TYPES.contains(&kind))
                            && decimal(&filesystem["total"])
                            && decimal(&filesystem["available"])
                            && filesystems[..index].iter().all(|other| other["id"] != filesystem["id"])
                    })
            })
        }
        "block" => validate_block(value),
        _ => false,
    }
}

fn validate_sample(value: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    if !keys(value, &SAMPLE_KEYS) || !map.contains_key("seq") || !map.contains_key("atMs") || !map.contains_key("monoMs") {
        return false;
    }
    if !timestamp(&value["atMs"]) || !timestamp(&value["seq"]) || !timestamp(&value["monoMs"]) {
        return false;
    }
    let mut unavailable = HashSet::new();
    if let Some(groups) = map.get("unavailable") {
        let Some(groups) = groups.as_array() else { return false };
        if groups.len() > 8 {
            return false;
        }
        for group in groups {
            let Some(name) = group.as_str() else { return false };
            if !UNAVAILABLE.contains(&name) || !unavailable.insert(name) {
                return false;
            }
        }
    }
    let metrics: Vec<&str> = ["cpu", "load", "mem", "uptimeMs", "disks", "nets", "psi", "filesystems", "block"]
        .into_iter()
        .filter(|key| map.contains_key(*key))
        .collect();
    if metrics.is_empty() {
        return false;
    }
    for key in &metrics {
        if !validate_group(value, key) {
            return false;
        }
    }
    !unavailable.iter().any(|group| {
        let key = if *group == "uptime" { "uptimeMs" } else { *group };
        map.contains_key(key)
    })
}

fn text(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty() && text.chars().count() <= limit && !text.chars().any(char::is_control))
}

fn bounded(value: &Value, high: u64) -> bool {
    value.as_u64().is_some_and(|number| (1..=high).contains(&number))
}

fn validate_system(value: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    if !keys(value, &["agent", "hostname", "os", "kernel", "arch", "cpu"]) || !["agent", "hostname", "kernel", "arch", "cpu"].iter().all(|key| map.contains_key(*key)) {
        return false;
    }
    let cpu = &value["cpu"];
    text(&value["agent"], 32)
        && text(&value["hostname"], 64)
        && map.get("os").is_none_or(|os| text(os, 128))
        && text(&value["kernel"], 64)
        && text(&value["arch"], 16)
        && keys(cpu, &["model", "threads", "cores", "sockets", "maxMhz"])
        && bounded(&cpu["threads"], 4096)
        && cpu.get("model").is_none_or(|model| text(model, 128))
        && cpu.get("cores").is_none_or(|cores| bounded(cores, 4096))
        && cpu.get("sockets").is_none_or(|sockets| bounded(sockets, 256))
        && cpu.get("maxMhz").is_none_or(|mhz| bounded(mhz, 100_000))
}

fn validate(text: &str) -> Result<(), Failure> {
    if text.len() > 65_536 {
        return Err(Failure::TooLarge);
    }
    let value: Value = serde_json::from_str(text).map_err(|_| Failure::InvalidJson)?;
    let Some(map) = value.as_object() else { return Err(Failure::InvalidBatch) };
    if !keys(&value, &["v", "hostId", "bootId", "samples", "system"]) || !["v", "hostId", "bootId", "samples"].iter().all(|key| map.contains_key(*key)) {
        return Err(Failure::InvalidBatch);
    }
    if value["v"].as_u64() != Some(1) {
        return Err(Failure::UnknownVersion);
    }
    if !value["hostId"].as_str().is_some_and(valid_host) || !value["bootId"].as_str().is_some_and(valid_boot) {
        return Err(Failure::InvalidBatch);
    }
    if map.get("system").is_some_and(|system| !validate_system(system)) {
        return Err(Failure::InvalidBatch);
    }
    let Some(samples) = value["samples"].as_array() else { return Err(Failure::InvalidBatch) };
    if samples.is_empty() || samples.len() > 16 {
        return Err(Failure::InvalidBatch);
    }
    if !samples.iter().all(validate_sample) {
        return Err(Failure::InvalidSample);
    }
    Ok(())
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/v1")
}

#[test]
fn fixture_manifest_matches_the_validator() {
    let directory = fixture_dir();
    let manifest: Value = serde_json::from_str(&fs::read_to_string(directory.join("manifest.json")).unwrap()).unwrap();
    let mut checked = 0;
    for entry in manifest["fixtures"].as_array().unwrap() {
        let file = entry["file"].as_str().unwrap();
        let text = fs::read_to_string(directory.join(file)).unwrap();
        let outcome = validate(&text);
        match entry["expect"].as_str().unwrap() {
            "accept" => assert_eq!(outcome, Ok(()), "{file}"),
            "reject" => assert_eq!(outcome.unwrap_err().code(), entry["code"].as_str().unwrap(), "{file}"),
            other => panic!("unknown expectation {other}"),
        }
        checked += 1;
    }
    assert_eq!(checked, manifest["fixtures"].as_array().unwrap().len());
}

#[cfg(target_os = "linux")]
#[test]
fn a_real_linux_sample_matches_the_wire_contract() {
    let sample = stats::sample_once(stats::CollectionScope::default()).expect("a Linux host should produce a sample");
    let value = serde_json::to_value(&sample).unwrap();
    assert!(validate_sample(&value), "{value}");
}

#[test]
fn every_fixture_file_is_manifested() {    let directory = fixture_dir();
    let manifest: Value = serde_json::from_str(&fs::read_to_string(directory.join("manifest.json")).unwrap()).unwrap();
    let listed: HashSet<String> = manifest["fixtures"].as_array().unwrap().iter().map(|entry| entry["file"].as_str().unwrap().to_owned()).collect();
    for entry in fs::read_dir(directory).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name != "manifest.json" {
            assert!(listed.contains(&name), "{name} is not manifested");
        }
    }
}

#[test]
fn serializer_uses_the_wire_names() {
    assert_eq!(stats::model::sequence_for(1_000_999), 1_000);
    let sample = Sample {
        cpu: Some(Cpu {
            user: "1".into(),
            system: "2".into(),
            idle: "3".into(),
            iowait: Some("4".into()),
            steal: Some("5".into()),
            total: "15".into(),
        }),
        ..Sample::empty(1, 2, 3)
    };
    let value = serde_json::to_value(&sample).unwrap();
    for key in ["seq", "atMs", "monoMs", "cpu"] {
        assert!(value.get(key).is_some(), "{key}");
    }
    assert_eq!(serde_json::to_value(Unavailable::Filesystems).unwrap().as_str(), Some("filesystems"));

    let disk = Disk { id: "8:0".into(), name: "sda".into(), reads: "1".into(), read_sectors: "2".into(), writes: "3".into(), write_sectors: "4".into(), io_ms: Some("5".into()) };
    let disk = serde_json::to_value(disk).unwrap();
    assert!(disk.get("readSectors").is_some() && disk.get("ioMs").is_some());

    let net = Net { id: "eth0".into(), rx_bytes: "1".into(), rx_packets: "2".into(), rx_drops: "3".into(), rx_errors: "4".into(), tx_bytes: "5".into(), tx_packets: "6".into(), tx_drops: Some("7".into()), tx_errors: "8".into() };
    let net = serde_json::to_value(net).unwrap();
    assert!(net.get("rxBytes").is_some() && net.get("txErrors").is_some());

    let psi = PsiGroup { some10: "0.00".into(), some60: "0.00".into(), some300: "0.00".into(), total: "0".into(), full10: Some("0.00".into()), full60: None, full300: None, full_total: None };
    let psi = serde_json::to_value(psi).unwrap();
    assert!(psi.get("full10").is_some() && psi.get("fullTotal").is_none());

    let filesystem = FileSystem { id: "/".into(), fs_type: "ext4".into(), total: "1".into(), available: "1".into() };
    let filesystem = serde_json::to_value(filesystem).unwrap();
    assert_eq!(filesystem["type"], "ext4");
}
