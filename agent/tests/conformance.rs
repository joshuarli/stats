use deser::Deserialize;
use deser_value::{Kind, Value};
use stats::model::{BootId, Cpu, Disk, DiskId, HostId, Net, Sample, SystemInfo};
use stats::wire::{self, Ack, Delta, Rejection, RejectionCode, MAX_BODY};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[deser(deny_unknown_fields)]
struct Source {
    #[deser(rename = "hostId")]
    host_id: String,
    #[deser(rename = "bootId")]
    boot_id: String,
    #[deser(default)]
    system: Option<SystemInfo>,
    samples: Vec<Sample>,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/v2")
}

fn writing() -> bool {
    std::env::var_os("STATS_WRITE_FIXTURES").is_some()
}

fn read_json(relative: &str) -> Value {
    deser_json::from_str(&fs::read_to_string(root().join(relative)).unwrap_or_else(|error| panic!("{relative}: {error}"))).unwrap()
}

fn canonical(value: &Value) -> String {
    match value.kind() {
        Kind::Map(map) => {
            let mut entries: Vec<(String, String)> = map.iter().map(|(key, value)| (key.as_str().unwrap().to_owned(), canonical(value))).collect();
            entries.sort();
            format!("{{{}}}", entries.iter().map(|(key, value)| format!("{key:?}:{value}")).collect::<Vec<_>>().join(","))
        }
        Kind::Seq(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        _ => deser_json::to_string(value).unwrap(),
    }
}

fn golden(relative: &str, bytes: &[u8]) {
    let path = root().join(relative);
    if writing() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        return;
    }
    let expected = fs::read(&path).unwrap_or_else(|error| panic!("{relative}: {error}; run make fixtures-write"));
    assert!(expected == bytes, "{relative}: the encoder output differs from the golden frame; run make fixtures-write and review the diff");
}

fn hex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().filter(|byte| !byte.is_ascii_whitespace()).collect();
    digits.chunks(2).map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect()
}

#[test]
fn the_encoder_reproduces_every_golden_frame_from_its_semantic_source() {
    let manifest = read_json("manifest.json");
    let batches = manifest["batches"].as_seq().unwrap();
    assert!(batches.len() >= 30);
    for entry in batches {
        let name = entry["name"].as_str().unwrap();
        let text = fs::read_to_string(root().join(entry["source"].as_str().unwrap())).unwrap();
        let source: Source = deser_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"));
        let original: Value = deser_json::from_str(&text).unwrap();
        for (index, sample) in source.samples.iter().enumerate() {
            let rendered = deser_value::to_value(sample).unwrap();
            assert_eq!(canonical(&rendered), canonical(&original["samples"][index]), "{name}[{index}] does not survive the model exactly");
        }
        let host: HostId = source.host_id.parse().unwrap();
        let boot: BootId = source.boot_id.parse().unwrap();
        let batch = wire::encode_batch(&host, &boot, source.system.as_ref(), &source.samples, MAX_BODY).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(batch.samples(), source.samples.len(), "{name}: every sample fits");
        golden(entry["frame"].as_str().unwrap(), &batch.body);
        let absolute = wire::encode_batch_with(&host, &boot, source.system.as_ref(), &source.samples, MAX_BODY, Delta::AbsoluteOnly).unwrap();
        golden(&format!("frames/{name}.absolute.stb2"), &absolute.body);
        assert!(batch.body.len() <= absolute.body.len(), "{name}: deltas never grow a frame");
    }
}

#[test]
fn hand_annotated_vectors_match_the_encoder_byte_for_byte() {
    let annotated = read_json("annotated.json");
    let vectors = annotated["vectors"].as_seq().unwrap();
    assert!(vectors.len() >= 3);
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        let bytes: Vec<u8> = vector["bytes"].as_seq().unwrap().iter().flat_map(|segment| hex(segment[0].as_str().unwrap())).collect();
        let frame = fs::read(root().join(format!("frames/{}.stb2", vector["batch"].as_str().unwrap()))).unwrap();
        assert_eq!(bytes, frame, "{name}");
    }
}

fn code(name: &str) -> RejectionCode {
    match name {
        "invalid_sample" => RejectionCode::InvalidSample,
        "too_old" => RejectionCode::TooOld,
        "conflict" => RejectionCode::Conflict,
        other => panic!("unknown code {other}"),
    }
}

#[test]
fn acknowledgments_written_by_the_server_encoder_decode_to_their_stated_values() {
    let acks = read_json("acks.json");
    let mut valid = 0;
    for case in acks["cases"].as_seq().unwrap() {
        let name = case["name"].as_str().unwrap();
        let sent: Vec<u64> = case["sent"].as_seq().unwrap().iter().map(|seq| seq.as_str().unwrap().parse().unwrap()).collect();
        let bytes = match case.get("frame") {
            Some(frame) => fs::read(root().join(frame.as_str().unwrap())).unwrap_or_else(|error| panic!("{name}: {error}")),
            None => hex(case["hex"].as_str().unwrap()),
        };
        let decoded = wire::decode_ack(&bytes, &sent);
        match case.get("ack") {
            Some(expected) => {
                valid += 1;
                let rejected = expected["rejected"].as_seq().unwrap().iter().map(|entry| Rejection { seq: entry["seq"].as_str().unwrap().parse().unwrap(), code: code(entry["code"].as_str().unwrap()) }).collect();
                let expected = Ack { accepted: expected["accepted"].as_u64().unwrap(), duplicates: expected["duplicates"].as_u64().unwrap(), rejected };
                assert_eq!(decoded, Ok(expected), "{name}");
            }
            None => assert_eq!(decoded.map_err(|error| error.0.to_owned()), Err(case["error"].as_str().unwrap().to_owned()), "{name}"),
        }
    }
    assert!(valid >= 4);
}

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn counter(&mut self) -> u64 {
        match self.below(8) {
            0 => u64::MAX - self.below(4),
            1 => self.below(2),
            2 => (1 << 53) + self.below(1 << 20),
            _ => self.below(1 << 40),
        }
    }
}

fn random_sample(random: &mut Random, seq: u64) -> Sample {
    let mut sample = Sample::empty(seq, 1_793_510_400_000 + random.below(1 << 30), seq * 1000 + random.below(1000));
    if random.below(5) > 0 {
        let user = random.counter();
        sample.cpu = Some(Cpu { user, system: random.counter(), idle: random.counter(), iowait: (random.below(2) == 0).then(|| random.counter()), steal: None, total: user });
    }
    if random.below(3) > 0 {
        let count = random.below(17) as u32;
        sample.disks = Some((0..count).map(|index| Disk { id: DiskId { major: 8, minor: index * 16 + random.below(2) as u32 * 512 }, name: format!("sd{}", random.below(3)), reads: random.counter(), read_sectors: random.counter(), writes: random.counter(), write_sectors: random.counter(), io_ms: (random.below(2) == 0).then(|| random.counter()), read_ms: (random.below(2) == 0).then(|| random.counter()), write_ms: (random.below(2) == 0).then(|| random.counter()), weighted_io_ms: (random.below(2) == 0).then(|| random.counter()), in_flight: (random.below(2) == 0).then(|| random.counter()) }).collect());
    }
    if random.below(3) > 0 {
        let count = random.below(17);
        sample.nets = Some((0..count).map(|index| Net { id: format!("n{}x{index}", random.below(4)), rx_bytes: random.counter(), rx_packets: random.counter(), rx_drops: 0, rx_errors: 0, tx_bytes: random.counter(), tx_packets: random.counter(), tx_drops: None, tx_errors: 0 }).collect());
    }
    sample.uptime_ms = (random.below(2) == 0).then(|| random.counter());
    sample
}

fn dedupe(sample: &mut Sample) {
    if let Some(nets) = &mut sample.nets {
        let mut seen = Vec::new();
        nets.retain(|net| !seen.contains(&net.id) && { seen.push(net.id.clone()); true });
    }
}

#[test]
fn a_cut_frame_is_exactly_the_frame_of_its_prefix_for_seeded_random_batches() {
    let host: HostId = "h_0123456789abcdef0123456789abcdef".parse().unwrap();
    let boot: BootId = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".parse().unwrap();
    let mut random = Random(0x9e37_79b9_7f4a_7c15);
    for _ in 0..300 {
        let count = 1 + random.below(16);
        let samples: Vec<Sample> = (0..count).map(|index| {
            let mut sample = random_sample(&mut random, 1000 + index);
            dedupe(&mut sample);
            sample
        }).collect();
        let full = wire::encode_batch(&host, &boot, None, &samples, MAX_BODY).unwrap();
        assert_eq!(full.samples(), samples.len());
        let cap = 39 + random.below(full.body.len() as u64);
        match wire::encode_batch(&host, &boot, None, &samples, cap as usize) {
            Ok(cut) => {
                assert!(cut.body.len() <= cap as usize);
                let alone = wire::encode_batch(&host, &boot, None, &samples[..cut.samples()], MAX_BODY).unwrap();
                assert_eq!(cut.body, alone.body);
                if cut.samples() < samples.len() {
                    let next = wire::encode_batch(&host, &boot, None, &samples[..cut.samples() + 1], MAX_BODY).unwrap();
                    assert!(next.body.len() > cap as usize);
                }
            }
            Err(wire::EncodeError::TooLarge(bytes)) => assert!(bytes > cap as usize),
            Err(error) => panic!("{error}"),
        }
        let tail = wire::encode_batch(&host, &boot, None, &samples[samples.len() / 2..], MAX_BODY).unwrap();
        let absolute = wire::encode_batch_with(&host, &boot, None, &samples[samples.len() / 2..], MAX_BODY, Delta::AbsoluteOnly).unwrap();
        assert_eq!(tail.body[..39], absolute.body[..39]);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn a_real_host_sample_encodes_and_survives_the_diagnostic_form() {
    let sample = stats::sample_once(stats::CollectionScope::default()).expect("this host should produce a sample");
    let host: HostId = "h_0123456789abcdef0123456789abcdef".parse().unwrap();
    let boot: BootId = stats::boot_identity().expect("boot id").parse().expect("boot id is a UUID");
    let system = stats::system_info().expect("system information");
    wire::check_system(&system).unwrap();
    let batch = wire::encode_batch(&host, &boot, Some(&system), std::slice::from_ref(&sample), MAX_BODY).unwrap();
    assert_eq!(batch.samples(), 1);
    let text = deser_json::to_string(&sample).unwrap();
    let back: Sample = deser_json::from_str(&text).unwrap();
    assert_eq!(back, sample);
}
