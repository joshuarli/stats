use crate::model::{sequence_for, Disk, FileSystem, Load, Mem, Net, Psi, Sample, Unavailable};
use crate::parse::{
    file_systems, fixed3, parse_cpu, parse_diskstats, parse_meminfo, parse_mounts, parse_psi, statfs_facts,
};
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const CPU_LIMIT: usize = 262_144;
const MEMINFO_LIMIT: usize = 65_536;
const DISKSTATS_LIMIT: usize = 262_144;
const PRESSURE_LIMIT: usize = 16_384;
const MOUNTS_LIMIT: usize = 65_536;
const COUNTER_LIMIT: usize = 64;

fn read_bounded(path: &Path, buffer: &mut Vec<u8>, limit: usize) -> std::io::Result<()> {
    buffer.clear();
    let file = File::open(path)?;
    file.take(limit as u64 + 1).read_to_end(buffer)?;
    if buffer.len() > limit {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "input exceeds limit"));
    }
    Ok(())
}

fn read_names(path: &str) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path)? {
        if let Ok(name) = entry?.file_name().into_string() {
            names.push(name);
        }
    }
    Ok(names)
}

fn valid_disk_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && !name.starts_with("loop")
        && !name.starts_with("ram")
        && !name.starts_with("zram")
        && !name.starts_with("fd")
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_ifname(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 15
        && name != "lo"
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-'))
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_hexdigit(),
        })
}

fn parse_counter(text: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(text).ok()?.trim();
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse::<u64>().ok()
}

fn read_counter(path: &str) -> Option<u64> {
    let mut buffer = Vec::with_capacity(COUNTER_LIMIT);
    read_bounded(Path::new(path), &mut buffer, COUNTER_LIMIT).ok()?;
    parse_counter(&buffer)
}

fn monotonic_ms() -> Option<u64> {
    let mut value: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut value) } != 0 || value.tv_sec < 0 {
        return None;
    }
    let seconds = u64::try_from(value.tv_sec).ok()?;
    let nanos = u64::try_from(value.tv_nsec).ok()?;
    seconds.checked_mul(1000)?.checked_add(nanos / 1_000_000)
}

fn wall_ms() -> Option<u64> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(elapsed.as_millis()).ok()
}

fn boot_id() -> Option<String> {
    let mut buffer = Vec::with_capacity(64);
    read_bounded(Path::new("/proc/sys/kernel/random/boot_id"), &mut buffer, COUNTER_LIMIT).ok()?;
    let value = std::str::from_utf8(&buffer).ok()?.trim();
    valid_uuid(value).then(|| value.to_owned())
}

struct SystemFacts {
    load: Load,
    uptime_ms: String,
    cpu_count: Option<u16>,
}

fn system_facts() -> Option<SystemFacts> {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    if unsafe { libc::sysinfo(&mut info) } != 0 {
        return None;
    }
    let uptime = u64::try_from(info.uptime).ok()?;
    let cpu = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    let cpu_count = (1..=4096).contains(&cpu).then(|| u16::try_from(cpu).ok()).flatten();
    Some(SystemFacts {
        load: Load {
            one: fixed3(info.loads[0]),
            five: fixed3(info.loads[1]),
            fifteen: fixed3(info.loads[2]),
        },
        uptime_ms: uptime.checked_mul(1000)?.to_string(),
        cpu_count,
    })
}

fn read_disks(buffer: &mut Vec<u8>) -> Option<Vec<Disk>> {
    let names = read_names("/sys/block").ok()?;
    let whole: HashSet<String> = names.into_iter().filter(|name| valid_disk_name(name)).collect();
    read_bounded(Path::new("/proc/diskstats"), buffer, DISKSTATS_LIMIT).ok()?;
    parse_diskstats(buffer, &whole)
}

fn read_nets() -> Option<Vec<Net>> {
    let names = read_names("/sys/class/net").ok()?;
    let mut nets = Vec::new();
    for name in names.into_iter().filter(|name| valid_ifname(name)) {
        let counter = |field: &str| read_counter(&format!("/sys/class/net/{name}/statistics/{field}"));
        let Some(rx_bytes) = counter("rx_bytes") else { continue };
        let Some(rx_packets) = counter("rx_packets") else { continue };
        let Some(rx_drops) = counter("rx_dropped") else { continue };
        let Some(rx_errors) = counter("rx_errors") else { continue };
        let Some(tx_bytes) = counter("tx_bytes") else { continue };
        let Some(tx_packets) = counter("tx_packets") else { continue };
        let Some(tx_drops) = counter("tx_dropped") else { continue };
        let Some(tx_errors) = counter("tx_errors") else { continue };
        nets.push(Net {
            id: name,
            rx_bytes: rx_bytes.to_string(),
            rx_packets: rx_packets.to_string(),
            rx_drops: rx_drops.to_string(),
            rx_errors: rx_errors.to_string(),
            tx_bytes: tx_bytes.to_string(),
            tx_packets: tx_packets.to_string(),
            tx_drops: tx_drops.to_string(),
            tx_errors: tx_errors.to_string(),
        });
        if nets.len() == 16 {
            break;
        }
    }
    Some(nets)
}

fn statfs(mount: &str) -> Option<(String, String)> {
    let path = CString::new(mount.as_bytes()).ok()?;
    let mut value: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut value) } != 0 {
        return None;
    }
    let block_size = u64::try_from(value.f_bsize).ok()?;
    let total = u64::try_from(value.f_blocks).ok()?;
    let available = u64::try_from(value.f_bavail).ok()?;
    statfs_facts(total, block_size, available)
}

fn read_filesystems(buffer: &mut Vec<u8>) -> Option<Vec<FileSystem>> {
    read_bounded(Path::new("/proc/self/mounts"), buffer, MOUNTS_LIMIT).ok()?;
    let mounts = parse_mounts(buffer);
    if mounts.is_empty() {
        return Some(Vec::new());
    }
    let filesystems = file_systems(mounts, statfs);
    if filesystems.is_empty() { None } else { Some(filesystems) }
}

fn read_psi() -> Option<Psi> {
    let mut cpu = Vec::with_capacity(PRESSURE_LIMIT);
    let mut memory = Vec::with_capacity(PRESSURE_LIMIT);
    let mut io = Vec::with_capacity(PRESSURE_LIMIT);
    let cpu_ok = read_bounded(Path::new("/proc/pressure/cpu"), &mut cpu, PRESSURE_LIMIT).is_ok();
    let memory_ok = read_bounded(Path::new("/proc/pressure/memory"), &mut memory, PRESSURE_LIMIT).is_ok();
    let io_ok = read_bounded(Path::new("/proc/pressure/io"), &mut io, PRESSURE_LIMIT).is_ok();
    if !cpu_ok && !memory_ok && !io_ok {
        return None;
    }
    parse_psi(if cpu_ok { &cpu } else { b"" }, if memory_ok { &memory } else { b"" }, if io_ok { &io } else { b"" })
}

fn read_mem(buffer: &mut Vec<u8>) -> Option<Mem> {
    read_bounded(Path::new("/proc/meminfo"), buffer, MEMINFO_LIMIT).ok()?;
    parse_meminfo(buffer)
}

pub fn sample() -> Option<Sample> {
    let mono_ms = monotonic_ms()?;
    let at_ms = wall_ms()?;
    let _boot = boot_id()?;
    let seq = sequence_for(mono_ms);
    let mut sample = Sample::empty(seq, at_ms, mono_ms);
    let mut buffer = Vec::with_capacity(MEMINFO_LIMIT);

    match read_bounded(Path::new("/proc/stat"), &mut buffer, CPU_LIMIT).ok().and_then(|()| parse_cpu(&buffer)) {
        Some(cpu) => sample.cpu = Some(cpu),
        None => sample.mark_unavailable(Unavailable::Cpu),
    }

    match read_mem(&mut buffer) {
        Some(mem) => sample.mem = Some(mem),
        None => sample.mark_unavailable(Unavailable::Mem),
    }

    match system_facts() {
        Some(facts) => {
            sample.load = Some(facts.load);
            sample.uptime_ms = Some(facts.uptime_ms);
            sample.cpu_count = facts.cpu_count;
        }
        None => {
            sample.mark_unavailable(Unavailable::Load);
            sample.mark_unavailable(Unavailable::Uptime);
        }
    }

    match read_disks(&mut buffer) {
        Some(disks) => sample.disks = Some(disks),
        None => sample.mark_unavailable(Unavailable::Disks),
    }

    match read_nets() {
        Some(nets) => sample.nets = Some(nets),
        None => sample.mark_unavailable(Unavailable::Nets),
    }

    match read_psi() {
        Some(psi) => sample.psi = Some(psi),
        None => sample.mark_unavailable(Unavailable::Psi),
    }

    match read_filesystems(&mut buffer) {
        Some(filesystems) => sample.filesystems = Some(filesystems),
        None => sample.mark_unavailable(Unavailable::Filesystems),
    }

    if !sample.has_metrics() {
        return None;
    }
    Some(sample)
}

#[cfg(target_os = "linux")]
pub fn boot_identity() -> Option<String> {
    boot_id()
}
