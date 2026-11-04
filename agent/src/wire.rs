use crate::model::{BootId, Cpu, Disk, DiskId, FileSystem, FileSystemType, HostId, Mem, MemoryPressure, Net, Power, PsiGroup, Sample, SwapActivity, SystemInfo, Unavailable, BLOCK_BUCKETS};
use std::fmt;

pub const REQUEST_MEDIA_TYPE: &str = "application/vnd.stats.ingest.v2";
pub const ACK_MEDIA_TYPE: &str = "application/vnd.stats.ingest-ack.v2";
pub const MAX_BODY: usize = 65_536;
pub const MAX_SAMPLES: usize = 16;
pub const MAX_DEVICES: usize = 16;
pub const MAX_ACK_BYTES: usize = 512;

const REQUEST_MAGIC: &[u8; 4] = b"STB2";
const ACK_MAGIC: &[u8; 4] = b"STA2";
const VERSION: u8 = 2;
const FLAG_SYSTEM: u8 = 1;
const COUNT_OFFSET: usize = 38;

const CPU: u32 = 1 << 0;
const LOAD: u32 = 1 << 1;
const MEM: u32 = 1 << 2;
const UPTIME: u32 = 1 << 3;
const CPU_COUNT: u32 = 1 << 4;
const DISKS: u32 = 1 << 5;
const NETS: u32 = 1 << 6;
const PSI: u32 = 1 << 7;
const FILESYSTEMS: u32 = 1 << 8;
const BLOCK: u32 = 1 << 9;
const GPU: u32 = 1 << 10;
const POWER: u32 = 1 << 11;

const AGENT_BYTES: usize = 128;
const HOSTNAME_BYTES: usize = 256;
const OS_BYTES: usize = 512;
const KERNEL_BYTES: usize = 256;
const ARCH_BYTES: usize = 64;
const MODEL_BYTES: usize = 512;
const DISK_NAME_BYTES: usize = 32;
const IFNAME_BYTES: usize = 15;
const PATH_BYTES: usize = 255;

fn unavailable_bit(group: Unavailable) -> u32 {
    match group {
        Unavailable::Cpu => CPU,
        Unavailable::Load => LOAD,
        Unavailable::Mem => MEM,
        Unavailable::Uptime => UPTIME,
        Unavailable::Disks => DISKS,
        Unavailable::Nets => NETS,
        Unavailable::Psi => PSI,
        Unavailable::Filesystems => FILESYSTEMS,
        Unavailable::Gpu => GPU,
        Unavailable::Power => POWER,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    Empty,
    Unencodable(&'static str),
    TooLarge(usize),
}

impl fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("empty batch"),
            Self::Unencodable(reason) => write!(formatter, "sample cannot be encoded: {reason}"),
            Self::TooLarge(bytes) => write!(formatter, "one sample needs a {bytes} byte frame, over the {MAX_BODY} byte cap"),
        }
    }
}

impl std::error::Error for EncodeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedBatch {
    pub body: Vec<u8>,
    pub seqs: Vec<u64>,
    pub system: bool,
}

impl EncodedBatch {
    pub fn samples(&self) -> usize {
        self.seqs.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delta {
    Enabled,
    AbsoluteOnly,
}

pub fn encode_batch(host: &HostId, boot: &BootId, system: Option<&SystemInfo>, samples: &[Sample], cap: usize) -> Result<EncodedBatch, EncodeError> {
    encode_batch_with(host, boot, system, samples, cap, Delta::Enabled)
}

pub fn encode_batch_with(host: &HostId, boot: &BootId, system: Option<&SystemInfo>, samples: &[Sample], cap: usize, delta: Delta) -> Result<EncodedBatch, EncodeError> {
    let samples = &samples[..samples.len().min(MAX_SAMPLES)];
    if samples.is_empty() {
        return Err(EncodeError::Empty);
    }
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(REQUEST_MAGIC);
    out.push(VERSION);
    out.push(if system.is_some() { FLAG_SYSTEM } else { 0 });
    out.extend_from_slice(&host.0);
    out.extend_from_slice(&boot.0);
    out.push(0);
    if let Some(system) = system {
        write_system(&mut out, system).map_err(EncodeError::Unencodable)?;
    }
    let mut dictionaries = Dictionaries::default();
    let mut seqs = Vec::with_capacity(samples.len());
    for (index, sample) in samples.iter().enumerate() {
        let start = out.len();
        let previous = match (index, delta) {
            (0, _) | (_, Delta::AbsoluteOnly) => None,
            _ => Some(&samples[index - 1]),
        };
        let written = write_sample(&mut out, sample, previous, &mut dictionaries);
        match written {
            Err(reason) if index == 0 => return Err(EncodeError::Unencodable(reason)),
            Ok(()) if out.len() > cap && index == 0 => return Err(EncodeError::TooLarge(out.len())),
            Err(_) => {
                out.truncate(start);
                break;
            }
            Ok(()) if out.len() > cap => {
                out.truncate(start);
                break;
            }
            Ok(()) => seqs.push(sample.seq),
        }
    }
    out[COUNT_OFFSET] = u8::try_from(seqs.len()).map_err(|_| EncodeError::Unencodable("sample count"))?;
    Ok(EncodedBatch { body: out, seqs, system: system.is_some() })
}

pub fn check_system(system: &SystemInfo) -> Result<(), &'static str> {
    write_system(&mut Vec::new(), system)
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn text(out: &mut Vec<u8>, value: &str, max: usize, field: &'static str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > max {
        return Err(field);
    }
    varint(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

fn system_text(out: &mut Vec<u8>, value: &str, bytes: usize, characters: usize, field: &'static str) -> Result<(), &'static str> {
    if value.chars().count() > characters || value.chars().any(char::is_control) {
        return Err(field);
    }
    text(out, value, bytes, field)
}

fn write_system(out: &mut Vec<u8>, system: &SystemInfo) -> Result<(), &'static str> {
    let cpu = &system.cpu;
    let mask = u8::from(system.os.is_some()) | u8::from(cpu.model.is_some()) << 1 | u8::from(cpu.cores.is_some()) << 2 | u8::from(cpu.sockets.is_some()) << 3 | u8::from(cpu.max_mhz.is_some()) << 4;
    out.push(mask);
    system_text(out, &system.agent, AGENT_BYTES, 32, "system agent")?;
    system_text(out, &system.hostname, HOSTNAME_BYTES, 64, "system hostname")?;
    if let Some(os) = &system.os {
        system_text(out, os, OS_BYTES, 128, "system os")?;
    }
    system_text(out, &system.kernel, KERNEL_BYTES, 64, "system kernel")?;
    system_text(out, &system.arch, ARCH_BYTES, 16, "system arch")?;
    if !(1..=4096).contains(&cpu.threads) {
        return Err("system threads");
    }
    varint(out, u64::from(cpu.threads));
    if let Some(model) = &cpu.model {
        system_text(out, model, MODEL_BYTES, 128, "system cpu model")?;
    }
    for (value, max, field) in [(cpu.cores, 4096, "system cores"), (cpu.sockets, 256, "system sockets"), (cpu.max_mhz, 100_000, "system maxMhz")] {
        if let Some(value) = value {
            if !(1..=max).contains(&value) {
                return Err(field);
            }
            varint(out, u64::from(value));
        }
    }
    Ok(())
}

struct Counters {
    values: [u64; 8],
    len: usize,
}

impl Counters {
    fn new(required: &[u64], optional: &[Option<u64>]) -> Self {
        let mut counters = Self { values: [0; 8], len: 0 };
        for value in required.iter().copied().chain(optional.iter().flatten().copied()) {
            counters.values[counters.len] = value;
            counters.len += 1;
        }
        counters
    }

    fn slice(&self) -> &[u64] {
        &self.values[..self.len]
    }

    fn deltable_from<'p>(&self, previous: Option<&'p Counters>) -> Option<&'p Counters> {
        previous.filter(|previous| self.slice().iter().zip(previous.slice()).all(|(current, previous)| current >= previous))
    }

    fn write(&self, out: &mut Vec<u8>, base: Option<&Counters>) {
        match base {
            Some(base) => self.slice().iter().zip(base.slice()).for_each(|(current, previous)| varint(out, current - previous)),
            None => self.slice().iter().for_each(|value| varint(out, *value)),
        }
    }
}

fn counter_record(out: &mut Vec<u8>, head: u8, delta_bit: u8, current: &Counters, previous: Option<&Counters>) {
    let base = current.deltable_from(previous);
    out.push(head | if base.is_some() { delta_bit } else { 0 });
    current.write(out, base);
}

fn cpu_counters(cpu: &Cpu) -> (u8, Counters) {
    let shape = u8::from(cpu.iowait.is_some()) | u8::from(cpu.steal.is_some()) << 1;
    let values = Counters::new(&[cpu.user, cpu.system, cpu.idle], &[cpu.iowait, cpu.steal, Some(cpu.total)]);
    (shape, values)
}

fn disk_counters(disk: &Disk) -> (u8, Counters) {
    (u8::from(disk.io_ms.is_some()), Counters::new(&[disk.reads, disk.read_sectors, disk.writes, disk.write_sectors], &[disk.io_ms]))
}

fn net_counters(net: &Net) -> (u8, Counters) {
    (u8::from(net.tx_drops.is_some()), Counters::new(&[net.rx_bytes, net.rx_packets, net.rx_drops, net.rx_errors, net.tx_bytes, net.tx_packets, net.tx_errors], &[net.tx_drops]))
}

fn psi_counters(group: &PsiGroup) -> (u8, Counters) {
    (u8::from(group.full.is_some()), Counters::new(&[group.total], &[group.full.map(|full| full.total)]))
}

fn power_counters(power: &Power) -> (u8, Counters) {
    let shape = u8::from(power.gpu_nj.is_some()) | u8::from(power.system.is_some()) << 1;
    let system = power.system.as_ref();
    (shape, Counters::new(&[], &[power.gpu_nj, system.map(|system| system.milliwatt_sum), system.map(|system| system.readings)]))
}

fn same_shape(current: (u8, Counters), previous: Option<(u8, Counters)>) -> (u8, Counters, Option<Counters>) {
    let (shape, values) = current;
    let previous = previous.filter(|(previous_shape, _)| *previous_shape == shape).map(|(_, values)| values);
    (shape, values, previous)
}

#[derive(Default)]
struct Dictionaries<'a> {
    disks: Vec<(DiskId, &'a str)>,
    nets: Vec<&'a str>,
    filesystems: Vec<(&'a str, FileSystemType)>,
}

fn reference<T: PartialEq + Copy>(out: &mut Vec<u8>, entries: &mut Vec<T>, entry: T) -> bool {
    match entries.iter().position(|known| *known == entry) {
        Some(index) => {
            varint(out, index as u64 + 1);
            false
        }
        None => {
            varint(out, 0);
            entries.push(entry);
            true
        }
    }
}

fn unique_ids<T: PartialEq>(ids: impl Iterator<Item = T>) -> bool {
    let ids: Vec<T> = ids.collect();
    ids.iter().enumerate().all(|(index, id)| !ids[..index].contains(id))
}

fn write_sample<'a>(out: &mut Vec<u8>, sample: &'a Sample, previous: Option<&'a Sample>, dictionaries: &mut Dictionaries<'a>) -> Result<(), &'static str> {
    let present = [
        (sample.cpu.is_some(), CPU),
        (sample.load.is_some(), LOAD),
        (sample.mem.is_some(), MEM),
        (sample.uptime_ms.is_some(), UPTIME),
        (sample.cpu_count.is_some(), CPU_COUNT),
        (sample.disks.is_some(), DISKS),
        (sample.nets.is_some(), NETS),
        (sample.psi.is_some(), PSI),
        (sample.filesystems.is_some(), FILESYSTEMS),
        (sample.block.is_some(), BLOCK),
        (sample.gpu.is_some(), GPU),
        (sample.power.is_some(), POWER),
    ]
    .iter()
    .filter(|(present, _)| *present)
    .fold(0, |mask, (_, bit)| mask | bit);
    let unavailable = sample.unavailable.iter().fold(0, |mask, group| mask | unavailable_bit(*group));
    if present & unavailable != 0 {
        return Err("a group is both present and unavailable");
    }
    varint(out, sample.seq);
    varint(out, sample.at_ms);
    varint(out, sample.mono_ms);
    varint(out, u64::from(present));
    varint(out, u64::from(unavailable));

    if let Some(cpu) = &sample.cpu {
        let (shape, values, base) = same_shape(cpu_counters(cpu), previous.and_then(|previous| previous.cpu.as_ref()).map(cpu_counters));
        counter_record(out, shape, 1 << 2, &values, base.as_ref());
    }
    if let Some(load) = &sample.load {
        for value in [load.one, load.five, load.fifteen] {
            varint(out, value.0);
        }
    }
    if let Some(mem) = &sample.mem {
        write_mem(out, mem, previous.and_then(|previous| previous.mem.as_ref()));
    }
    if let Some(uptime) = sample.uptime_ms {
        let base = previous.and_then(|previous| previous.uptime_ms).map(|value| Counters::new(&[value], &[]));
        counter_record(out, 0, 1, &Counters::new(&[uptime], &[]), base.as_ref());
    }
    if let Some(count) = sample.cpu_count {
        varint(out, u64::from(count));
    }
    if let Some(disks) = &sample.disks {
        if disks.len() > MAX_DEVICES || !unique_ids(disks.iter().map(|disk| disk.id)) {
            return Err("disks");
        }
        varint(out, disks.len() as u64);
        for disk in disks {
            if reference(out, &mut dictionaries.disks, (disk.id, disk.name.as_str())) {
                varint(out, u64::from(disk.id.major));
                varint(out, u64::from(disk.id.minor));
                text(out, &disk.name, DISK_NAME_BYTES, "disk name")?;
            }
            let predecessor = previous.and_then(|previous| previous.disks.as_ref()).and_then(|disks| disks.iter().find(|other| other.id == disk.id)).map(disk_counters);
            let (shape, values, base) = same_shape(disk_counters(disk), predecessor);
            counter_record(out, shape, 1 << 1, &values, base.as_ref());
        }
    }
    if let Some(nets) = &sample.nets {
        if nets.len() > MAX_DEVICES || !unique_ids(nets.iter().map(|net| net.id.as_str())) {
            return Err("nets");
        }
        varint(out, nets.len() as u64);
        for net in nets {
            if reference(out, &mut dictionaries.nets, net.id.as_str()) {
                text(out, &net.id, IFNAME_BYTES, "interface name")?;
            }
            let predecessor = previous.and_then(|previous| previous.nets.as_ref()).and_then(|nets| nets.iter().find(|other| other.id == net.id)).map(net_counters);
            let (shape, values, base) = same_shape(net_counters(net), predecessor);
            counter_record(out, shape, 1 << 1, &values, base.as_ref());
        }
    }
    if let Some(psi) = &sample.psi {
        let resources = [psi.cpu.as_ref(), psi.memory.as_ref(), psi.io.as_ref()];
        let mask = resources.iter().enumerate().filter(|(_, group)| group.is_some()).fold(0_u8, |mask, (index, _)| mask | 1 << index);
        if mask == 0 {
            return Err("psi has no resource");
        }
        out.push(mask);
        let before = previous.and_then(|previous| previous.psi.as_ref()).map(|psi| [psi.cpu.as_ref(), psi.memory.as_ref(), psi.io.as_ref()]);
        for (index, group) in resources.iter().enumerate() {
            let Some(group) = group else { continue };
            let predecessor = before.and_then(|before| before[index]).map(psi_counters);
            let (shape, values, base) = same_shape(psi_counters(group), predecessor);
            let base = values.deltable_from(base.as_ref());
            out.push(shape | if base.is_some() { 1 << 1 } else { 0 });
            for value in [group.some10, group.some60, group.some300] {
                varint(out, value.0);
            }
            varint(out, values.values[0] - base.map_or(0, |base| base.values[0]));
            if let Some(full) = &group.full {
                for value in [full.avg10, full.avg60, full.avg300] {
                    varint(out, value.0);
                }
                varint(out, values.values[1] - base.map_or(0, |base| base.values[1]));
            }
        }
    }
    if let Some(filesystems) = &sample.filesystems {
        if filesystems.len() > MAX_DEVICES || !unique_ids(filesystems.iter().map(|filesystem| filesystem.id.as_str())) {
            return Err("filesystems");
        }
        varint(out, filesystems.len() as u64);
        for filesystem in filesystems {
            write_filesystem(out, filesystem, &mut dictionaries.filesystems)?;
        }
    }
    if let Some(block) = &sample.block {
        for bucket in block.buckets.iter().take(BLOCK_BUCKETS) {
            varint(out, *bucket);
        }
        for value in [block.count, block.total_us, block.min_us, block.max_us] {
            varint(out, value);
        }
    }
    if let Some(gpu) = &sample.gpu {
        let base = previous.and_then(|previous| previous.gpu.as_ref()).map(|gpu| Counters::new(&[gpu.active, gpu.total], &[]));
        counter_record(out, 0, 1, &Counters::new(&[gpu.active, gpu.total], &[]), base.as_ref());
    }
    if let Some(power) = &sample.power {
        let (shape, values, base) = same_shape(power_counters(power), previous.and_then(|previous| previous.power.as_ref()).map(power_counters));
        if shape == 0 {
            return Err("power has no reading");
        }
        counter_record(out, shape, 1 << 2, &values, base.as_ref());
    }
    Ok(())
}

fn write_mem(out: &mut Vec<u8>, mem: &Mem, previous: Option<&Mem>) {
    let counters = |activity: &SwapActivity| Counters::new(&[activity.swap_in, activity.swap_out], &[]);
    let swap = mem.swap_activity.as_ref().map(counters);
    let previous = previous.and_then(|previous| previous.swap_activity.as_ref()).map(counters);
    let base = swap.as_ref().and_then(|swap| swap.deltable_from(previous.as_ref()));
    let head = u8::from(swap.is_some()) | u8::from(mem.pressure.is_some()) << 1 | if base.is_some() { 1 << 2 } else { 0 };
    out.push(head);
    for value in [mem.total, mem.available, mem.swap_total, mem.swap_free] {
        varint(out, value);
    }
    if let Some(swap) = &swap {
        swap.write(out, base);
    }
    if let Some(pressure) = mem.pressure {
        out.push(match pressure {
            MemoryPressure::Normal => 0,
            MemoryPressure::Warn => 1,
            MemoryPressure::Critical => 2,
        });
    }
}

fn write_filesystem<'a>(out: &mut Vec<u8>, filesystem: &'a FileSystem, entries: &mut Vec<(&'a str, FileSystemType)>) -> Result<(), &'static str> {
    if reference(out, entries, (filesystem.id.as_str(), filesystem.fs_type)) {
        text(out, &filesystem.id, PATH_BYTES, "filesystem path")?;
        out.push(filesystem.fs_type.wire());
    }
    varint(out, filesystem.total);
    varint(out, filesystem.available);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionCode {
    InvalidSample,
    TooOld,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejection {
    pub seq: u64,
    pub code: RejectionCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ack {
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: Vec<Rejection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AckError(pub &'static str);

impl fmt::Display for AckError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid acknowledgment: {}", self.0)
    }
}

impl std::error::Error for AckError {}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, AckError> {
        let byte = *self.bytes.get(self.offset).ok_or(AckError("truncated"))?;
        self.offset += 1;
        Ok(byte)
    }

    fn varint(&mut self) -> Result<u64, AckError> {
        let mut value = 0_u64;
        for index in 0..10 {
            let byte = self.byte()?;
            if index == 9 && byte > 1 {
                return Err(AckError("varint exceeds u64"));
            }
            value |= u64::from(byte & 0x7f) << (7 * index);
            if byte & 0x80 == 0 {
                if byte == 0 && index > 0 {
                    return Err(AckError("non-canonical varint"));
                }
                return Ok(value);
            }
        }
        Err(AckError("varint is too long"))
    }
}

pub fn decode_ack(bytes: &[u8], sent: &[u64]) -> Result<Ack, AckError> {
    if bytes.len() > MAX_ACK_BYTES {
        return Err(AckError("body exceeds its bound"));
    }
    if bytes.len() < 5 || &bytes[..4] != ACK_MAGIC {
        return Err(AckError("magic"));
    }
    if bytes[4] != VERSION {
        return Err(AckError("version"));
    }
    let mut reader = Reader { bytes, offset: 5 };
    let accepted = reader.varint()?;
    let duplicates = reader.varint()?;
    let count = reader.varint()?;
    if count > MAX_SAMPLES as u64 {
        return Err(AckError("too many rejections"));
    }
    let total = accepted.checked_add(duplicates).and_then(|sum| sum.checked_add(count)).ok_or(AckError("counts overflow"))?;
    if total != sent.len() as u64 {
        return Err(AckError("counts do not cover the batch"));
    }
    if accepted == 0 && duplicates == 0 {
        return Err(AckError("a success acknowledgment delivered nothing"));
    }
    let mut rejected = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let seq = reader.varint()?;
        let code = match reader.byte()? {
            1 => RejectionCode::InvalidSample,
            2 => RejectionCode::TooOld,
            3 => RejectionCode::Conflict,
            _ => return Err(AckError("unknown rejection code")),
        };
        let carried = sent.iter().filter(|candidate| **candidate == seq).count();
        let named = rejected.iter().filter(|rejection: &&Rejection| rejection.seq == seq).count();
        if named >= carried {
            return Err(AckError("rejection names a sample the batch did not carry"));
        }
        rejected.push(Rejection { seq, code });
    }
    if reader.offset != bytes.len() {
        return Err(AckError("trailing bytes"));
    }
    Ok(Ack { accepted, duplicates, rejected })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Gpu, Hundredths, Load, Psi, PsiFull, SystemPower, Thousandths};

    fn ids() -> (HostId, BootId) {
        ("h_0123456789abcdef0123456789abcdef".parse().unwrap(), "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".parse().unwrap())
    }

    fn cpu(seq: u64, user: u64) -> Sample {
        Sample { cpu: Some(Cpu { user, system: 2, idle: 3, iowait: None, steal: None, total: user + 5 }), ..Sample::empty(seq, 1_000 + seq, 10_000 + seq) }
    }

    #[test]
    fn varints_are_canonical_leb128() {
        let mut out = Vec::new();
        for value in [0, 127, 128, 300, u64::MAX] {
            varint(&mut out, value);
        }
        assert_eq!(out, [0x00, 0x7f, 0x80, 0x01, 0xac, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
        let mut reader = Reader { bytes: &out, offset: 0 };
        for value in [0, 127, 128, 300, u64::MAX] {
            assert_eq!(reader.varint(), Ok(value));
        }
        for bad in [&[0x80, 0x00][..], &[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02], &[0x80; 11], &[0x80]] {
            assert!(Reader { bytes: bad, offset: 0 }.varint().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_minimal_frame_has_the_documented_header() {
        let (host, boot) = ids();
        let batch = encode_batch(&host, &boot, None, &[cpu(1, 1)], MAX_BODY).unwrap();
        assert_eq!(&batch.body[..6], b"STB2\x02\x00");
        assert_eq!(&batch.body[6..22], &host.0);
        assert_eq!(&batch.body[22..38], &boot.0);
        assert_eq!(batch.body[38], 1);
        assert_eq!(&batch.body[39..], [1, 0xe9, 0x07, 0x91, 0x4e, 0x01, 0x00, 0x00, 1, 2, 3, 6]);
    }

    #[test]
    fn later_samples_send_counter_increments_and_regressions_send_absolutes() {
        let (host, boot) = ids();
        let delta = encode_batch(&host, &boot, None, &[cpu(1, 1_000_000), cpu(2, 1_000_001)], MAX_BODY).unwrap();
        let absolute = encode_batch_with(&host, &boot, None, &[cpu(1, 1_000_000), cpu(2, 1_000_001)], MAX_BODY, Delta::AbsoluteOnly).unwrap();
        assert!(delta.body.len() < absolute.body.len());
        let tail = &delta.body[delta.body.len() - 5..];
        assert_eq!(tail, [0b100, 1, 0, 0, 1]);
        let reset = encode_batch(&host, &boot, None, &[cpu(1, 1_000_000), cpu(2, 7)], MAX_BODY).unwrap();
        assert_eq!(&reset.body[reset.body.len() - 5..], [0, 7, 2, 3, 12]);
    }

    #[test]
    fn the_prefix_that_fits_is_what_is_sent() {
        let (host, boot) = ids();
        let samples: Vec<Sample> = (0..16).map(|index| cpu(index, index)).collect();
        let full = encode_batch(&host, &boot, None, &samples, MAX_BODY).unwrap();
        let cap = full.body.len() - 1;
        let cut = encode_batch(&host, &boot, None, &samples, cap).unwrap();
        assert_eq!(cut.samples(), 15);
        assert!(cut.body.len() <= cap);
        assert_eq!(cut.body[38], 15);
        assert_eq!(cut.body[39..], full.body[39..cut.body.len()]);
        assert_eq!(encode_batch(&host, &boot, None, &samples, 40), Err(EncodeError::TooLarge(51)));
        assert_eq!(encode_batch(&host, &boot, None, &[], MAX_BODY), Err(EncodeError::Empty));
    }

    #[test]
    fn an_unencodable_sample_ends_the_prefix_or_fails_alone() {
        let (host, boot) = ids();
        let mut bad = cpu(2, 2);
        bad.unavailable.push(Unavailable::Cpu);
        let batch = encode_batch(&host, &boot, None, &[cpu(1, 1), bad.clone(), cpu(3, 3)], MAX_BODY).unwrap();
        assert_eq!(batch.seqs, [1]);
        assert!(matches!(encode_batch(&host, &boot, None, &[bad], MAX_BODY), Err(EncodeError::Unencodable(_))));
    }

    #[test]
    fn dictionaries_define_once_and_rename_gets_a_new_entry() {
        let (host, boot) = ids();
        let disk = |name: &str, reads: u64| Disk { id: DiskId { major: 8, minor: 0 }, name: name.into(), reads, read_sectors: 0, writes: 0, write_sectors: 0, io_ms: None };
        let with = |seq: u64, disk: Disk| Sample { disks: Some(vec![disk]), ..Sample::empty(seq, seq, seq) };
        let batch = encode_batch(&host, &boot, None, &[with(1, disk("sda", 5)), with(2, disk("sda", 6)), with(3, disk("sdb", 7))], MAX_BODY).unwrap();
        let body = &batch.body[39..];
        assert_eq!(&body[..13], [1, 1, 1, 0x20, 0, 1, 0, 8, 0, 3, b's', b'd', b'a']);
        assert_eq!(&body[13..18], [0, 5, 0, 0, 0]);
        assert_eq!(&body[18..30], [2, 2, 2, 0x20, 0, 1, 1, 2, 1, 0, 0, 0]);
        assert_eq!(&body[30..36], [3, 3, 3, 0x20, 0, 1]);
        assert_eq!(&body[36..42], [0, 8, 0, 3, b's', b'd']);
    }

    #[test]
    fn every_group_encodes_in_bit_order() {
        let (host, boot) = ids();
        let sample = Sample {
            load: Some(Load { one: Thousandths(120), five: Thousandths(200), fifteen: Thousandths(310) }),
            mem: Some(Mem { total: 8, available: 4, swap_total: 2, swap_free: 1, swap_activity: Some(SwapActivity { swap_in: 10, swap_out: 20 }), pressure: Some(MemoryPressure::Critical) }),
            uptime_ms: Some(1),
            cpu_count: Some(8),
            psi: Some(Psi { cpu: None, memory: None, io: Some(PsiGroup { some10: Hundredths(1), some60: Hundredths(2), some300: Hundredths(3), total: 4, full: Some(PsiFull { avg10: Hundredths(5), avg60: Hundredths(6), avg300: Hundredths(7), total: 8 }) }) }),
            gpu: Some(Gpu { active: 1, total: 2 }),
            power: Some(Power { gpu_nj: None, system: Some(SystemPower { milliwatt_sum: 3, readings: 4 }) }),
            ..cpu(1, 1)
        };
        let batch = encode_batch(&host, &boot, None, &[sample], MAX_BODY).unwrap();
        let body = &batch.body[39..];
        assert_eq!(&body[5..8], [0x9f, 0x19, 0]);
        assert_eq!(&body[8..], [0, 1, 2, 3, 6, 120, 0xc8, 0x01, 0xb6, 0x02, 0b011, 8, 4, 2, 1, 10, 20, 2, 0, 1, 8, 0b100, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 0b10, 3, 4]);
    }

    fn ack(parts: &[u8]) -> Vec<u8> {
        [b"STA2\x02".as_slice(), parts].concat()
    }

    #[test]
    fn acknowledgments_must_account_for_every_sample() {
        assert_eq!(decode_ack(&ack(&[1, 0, 1, 2, 2]), &[1, 2]), Ok(Ack { accepted: 1, duplicates: 0, rejected: vec![Rejection { seq: 2, code: RejectionCode::TooOld }] }));
        assert_eq!(decode_ack(&ack(&[0, 2, 0]), &[1, 2]).map(|ack| ack.duplicates), Ok(2));
        for (body, reason) in [
            (ack(&[3, 0, 0]), "counts do not cover the batch"),
            (ack(&[1, 0, 1, 9, 1]), "rejection names a sample the batch did not carry"),
            (ack(&[0, 0, 2, 1, 1, 2, 1]), "a success acknowledgment delivered nothing"),
            (ack(&[1, 0, 1, 2, 4]), "unknown rejection code"),
            (ack(&[2, 0, 0, 0]), "trailing bytes"),
            (ack(&[2, 0]), "truncated"),
            (ack(&[0x82, 0x00, 0, 0]), "non-canonical varint"),
            (b"STA1\x02\x02\x00\x00".to_vec(), "magic"),
            (b"STA2\x03\x02\x00\x00".to_vec(), "version"),
            (ack(&[0, 0, 17]), "too many rejections"),
        ] {
            assert_eq!(decode_ack(&body, &[1, 2]), Err(AckError(reason)), "{body:?}");
        }
        assert_eq!(decode_ack(&ack(&[1, 0, 2, 1, 1, 1, 3]), &[1, 1, 1]).map(|ack| ack.rejected.len()), Ok(2));
        assert_eq!(decode_ack(&ack(&[0, 0, 2, 1, 1, 2, 3]), &[1, 2]), Err(AckError("a success acknowledgment delivered nothing")));
    }
}
