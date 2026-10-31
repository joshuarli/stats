use niceforge_telemetry::model::{Cpu, Disk, FileSystem, Net, PsiGroup, Sample, Unavailable};
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

const SAMPLE_KEYS: [&str; 13] = ["seq", "atMs", "monoMs", "unavailable", "cpu", "load", "mem", "uptimeMs", "cpuCount", "disks", "nets", "psi", "filesystems"];
const UNAVAILABLE: [&str; 8] = ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems"];
const FS_TYPES: [&str; 12] = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay"];

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

fn timestamp(value: &Value) -> bool {
    u64_value(value).is_some_and(|value| value <= i64::MAX as u64)
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

fn u64_map(value: &Value, keys: &[&str]) -> bool {
    object(value, keys) && keys.iter().all(|key| decimal(&value[*key]))
}

fn id(value: &Value, valid: impl Fn(&str) -> bool) -> bool {
    value.as_str().is_some_and(valid)
}

fn valid_disk_id(text: &str) -> bool {
    let Some((major, minor)) = text.split_once(':') else { return false };
    !major.is_empty() && !minor.is_empty() && major.bytes().all(|byte| byte.is_ascii_digit()) && minor.bytes().all(|byte| byte.is_ascii_digit())
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

fn validate_group(sample: &Value, key: &str) -> bool {
    let value = &sample[key];
    match key {
        "cpu" => u64_map(value, &["user", "system", "idle", "iowait", "steal", "total"]),
        "load" => object(value, &["one", "five", "fifteen"]) && ["one", "five", "fifteen"].iter().all(|field| fixed(&value[*field], 3)),
        "mem" => u64_map(value, &["total", "available", "swapTotal", "swapFree"]),
        "uptimeMs" => decimal(value),
        "cpuCount" => value.as_u64().is_some_and(|count| (1..=4096).contains(&count)),
        "disks" => {
            value.as_array().is_some_and(|devices| {
                devices.len() <= 16
                    && devices.iter().enumerate().all(|(index, device)| {
                        object(device, &["id", "name", "reads", "readSectors", "writes", "writeSectors", "ioMs"])
                            && id(&device["id"], valid_disk_id)
                            && id(&device["name"], valid_name)
                            && ["reads", "readSectors", "writes", "writeSectors", "ioMs"].iter().all(|field| decimal(&device[*field]))
                            && devices[..index].iter().all(|other| other["id"] != device["id"])
                    })
            })
        }
        "nets" => {
            value.as_array().is_some_and(|interfaces| {
                interfaces.len() <= 16
                    && interfaces.iter().enumerate().all(|(index, interface)| {
                        object(interface, &["id", "rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"])
                            && id(&interface["id"], valid_ifname)
                            && ["rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"].iter().all(|field| decimal(&interface[*field]))
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
                            && filesystem["type"].as_str().is_some_and(|kind| FS_TYPES.contains(&kind))
                            && decimal(&filesystem["total"])
                            && decimal(&filesystem["available"])
                            && filesystems[..index].iter().all(|other| other["id"] != filesystem["id"])
                    })
            })
        }
        _ => false,
    }
}

fn validate_sample(value: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    if !keys(value, &SAMPLE_KEYS) || !map.contains_key("seq") || !map.contains_key("atMs") || !map.contains_key("monoMs") {
        return false;
    }
    if !timestamp(&value["atMs"]) || !decimal(&value["seq"]) || !decimal(&value["monoMs"]) {
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
    let metrics: Vec<&str> = ["cpu", "load", "mem", "uptimeMs", "disks", "nets", "psi", "filesystems"]
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

fn validate(text: &str) -> Result<(), Failure> {
    if text.len() > 65_536 {
        return Err(Failure::TooLarge);
    }
    let value: Value = serde_json::from_str(text).map_err(|_| Failure::InvalidJson)?;
    let Some(map) = value.as_object() else { return Err(Failure::InvalidBatch) };
    if map.len() != 4 || !["v", "hostId", "bootId", "samples"].iter().all(|key| map.contains_key(*key)) {
        return Err(Failure::InvalidBatch);
    }
    if value["v"].as_u64() != Some(1) {
        return Err(Failure::UnknownVersion);
    }
    if !value["hostId"].as_str().is_some_and(valid_host) || !value["bootId"].as_str().is_some_and(valid_boot) {
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

#[test]
fn every_fixture_file_is_manifested() {
    let directory = fixture_dir();
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
    assert_eq!(niceforge_telemetry::model::sequence_for(1_000_999), 1_000);
    let sample = Sample {
        cpu: Some(Cpu {
            user: "1".into(),
            system: "2".into(),
            idle: "3".into(),
            iowait: "4".into(),
            steal: "5".into(),
            total: "15".into(),
        }),
        ..Sample::empty(1, 2, 3)
    };
    let value = serde_json::to_value(&sample).unwrap();
    for key in ["seq", "atMs", "monoMs", "cpu"] {
        assert!(value.get(key).is_some(), "{key}");
    }
    assert_eq!(serde_json::to_value(Unavailable::Filesystems).unwrap().as_str(), Some("filesystems"));

    let disk = Disk { id: "8:0".into(), name: "sda".into(), reads: "1".into(), read_sectors: "2".into(), writes: "3".into(), write_sectors: "4".into(), io_ms: "5".into() };
    let disk = serde_json::to_value(disk).unwrap();
    assert!(disk.get("readSectors").is_some() && disk.get("ioMs").is_some());

    let net = Net { id: "eth0".into(), rx_bytes: "1".into(), rx_packets: "2".into(), rx_drops: "3".into(), rx_errors: "4".into(), tx_bytes: "5".into(), tx_packets: "6".into(), tx_drops: "7".into(), tx_errors: "8".into() };
    let net = serde_json::to_value(net).unwrap();
    assert!(net.get("rxBytes").is_some() && net.get("txErrors").is_some());

    let psi = PsiGroup { some10: "0.00".into(), some60: "0.00".into(), some300: "0.00".into(), total: "0".into(), full10: Some("0.00".into()), full60: None, full300: None, full_total: None };
    let psi = serde_json::to_value(psi).unwrap();
    assert!(psi.get("full10").is_some() && psi.get("fullTotal").is_none());

    let filesystem = FileSystem { id: "/".into(), fs_type: "ext4".into(), total: "1".into(), available: "1".into() };
    let filesystem = serde_json::to_value(filesystem).unwrap();
    assert_eq!(filesystem["type"], "ext4");
}
