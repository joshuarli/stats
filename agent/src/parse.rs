use crate::model::{Cpu, Disk, FileSystem, Mem, Psi, PsiGroup};
use std::collections::{BTreeMap, HashSet};

fn parse_u64(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse::<u64>().ok()
}

pub fn fixed3(raw: u64) -> String {
    let milli = raw.saturating_mul(1000).saturating_add(32_768) / 65_536;
    format!("{}.{:03}", milli / 1000, milli % 1000)
}

fn fixed2(text: &str) -> Option<String> {
    let (whole, fraction) = text.split_once('.')?;
    if whole.is_empty() || whole.len() > 3 || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if fraction.len() != 2 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(text.to_owned())
}

pub fn parse_cpu(bytes: &[u8]) -> Option<Cpu> {
    let text = std::str::from_utf8(bytes).ok()?;
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let fields: Vec<&str> = line.split_whitespace().skip(1).take(10).collect();
    if fields.len() < 4 {
        return None;
    }
    let field = |index: usize| parse_u64(fields.get(index).copied().unwrap_or("0"));
    let user = field(0)?;
    let nice = field(1)?;
    let system = field(2)?;
    let idle = field(3)?;
    let iowait = field(4)?;
    let irq = field(5)?;
    let softirq = field(6)?;
    let steal = field(7)?;
    let user_all = user.checked_add(nice)?;
    let system_all = system.checked_add(irq)?.checked_add(softirq)?;
    let total = user_all
        .checked_add(system_all)?
        .checked_add(idle)?
        .checked_add(iowait)?
        .checked_add(steal)?;
    Some(Cpu {
        user: user_all.to_string(),
        system: system_all.to_string(),
        idle: idle.to_string(),
        iowait: iowait.to_string(),
        steal: steal.to_string(),
        total: total.to_string(),
    })
}

pub fn parse_meminfo(bytes: &[u8]) -> Option<Mem> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else { continue };
        let Some(value) = rest.split_whitespace().next() else { continue };
        if let Some(value) = parse_u64(value) {
            values.insert(key.trim(), value);
        }
    }
    let kib = |key: &str| values.get(key).copied().and_then(|value| value.checked_mul(1024));
    Some(Mem {
        total: kib("MemTotal")?.to_string(),
        available: kib("MemAvailable")?.to_string(),
        swap_total: kib("SwapTotal")?.to_string(),
        swap_free: kib("SwapFree")?.to_string(),
    })
}

pub fn parse_diskstats(bytes: &[u8], whole: &HashSet<String>) -> Option<Vec<Disk>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut devices = BTreeMap::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().take(14).collect();
        if fields.len() < 14 {
            continue;
        }
        let Some(major) = parse_u64(fields[0]) else { continue };
        let Some(minor) = parse_u64(fields[1]) else { continue };
        if major > 4_095 || minor > 1_048_575 {
            continue;
        }
        let name = fields[2];
        if !whole.contains(name) {
            continue;
        }
        let Some(reads) = parse_u64(fields[3]) else { continue };
        let Some(read_sectors) = parse_u64(fields[5]) else { continue };
        let Some(writes) = parse_u64(fields[7]) else { continue };
        let Some(write_sectors) = parse_u64(fields[9]) else { continue };
        let Some(io_ms) = parse_u64(fields[12]) else { continue };
        let id = format!("{major}:{minor}");
        devices.insert(
            id.clone(),
            Disk {
                id,
                name: name.to_owned(),
                reads: reads.to_string(),
                read_sectors: read_sectors.to_string(),
                writes: writes.to_string(),
                write_sectors: write_sectors.to_string(),
                io_ms: io_ms.to_string(),
            },
        );
    }
    let mut devices: Vec<Disk> = devices.into_values().collect();
    devices.truncate(16);
    Some(devices)
}

pub fn parse_pressure(bytes: &[u8]) -> Option<PsiGroup> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut some = None;
    let mut full = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(kind) = parts.next() else { continue };
        let mut avg10 = None;
        let mut avg60 = None;
        let mut avg300 = None;
        let mut total = None;
        for part in parts {
            let (key, value) = part.split_once('=')?;
            match key {
                "avg10" => avg10 = Some(fixed2(value)?),
                "avg60" => avg60 = Some(fixed2(value)?),
                "avg300" => avg300 = Some(fixed2(value)?),
                "total" => total = Some(parse_u64(value)?.to_string()),
                _ => return None,
            }
        }
        let group = PsiGroup {
            some10: avg10?,
            some60: avg60?,
            some300: avg300?,
            total: total?,
            full10: None,
            full60: None,
            full300: None,
            full_total: None,
        };
        match kind {
            "some" => some = Some(group),
            "full" => full = Some(group),
            _ => return None,
        }
    }
    let mut group = some?;
    if let Some(full) = full {
        group.full10 = Some(full.some10);
        group.full60 = Some(full.some60);
        group.full300 = Some(full.some300);
        group.full_total = Some(full.total);
    }
    Some(group)
}

pub fn parse_psi(cpu: &[u8], memory: &[u8], io: &[u8]) -> Option<Psi> {
    let psi = Psi {
        cpu: parse_pressure(cpu),
        memory: parse_pressure(memory),
        io: parse_pressure(io),
    };
    if psi.is_empty() { None } else { Some(psi) }
}

fn unescape_mount(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(index) = rest.find('\\') {
        output.push_str(&rest[..index]);
        let tail = &rest[index + 1..];
        let bytes = tail.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2].is_ascii_digit() {
            let value = (bytes[0] - b'0') as u32 * 64 + (bytes[1] - b'0') as u32 * 8 + (bytes[2] - b'0') as u32;
            if let Some(character) = char::from_u32(value) {
                output.push(character);
                rest = &tail[3..];
                continue;
            }
        }
        output.push('\\');
        rest = tail;
    }
    output.push_str(rest);
    output
}

pub const FILESYSTEM_TYPES: [&str; 12] = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay"];

pub fn parse_mounts(bytes: &[u8]) -> Vec<(String, String)> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let mut mounts = BTreeMap::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().take(4).collect();
        if fields.len() < 3 {
            continue;
        }
        let fs_type = fields[2];
        if !FILESYSTEM_TYPES.contains(&fs_type) {
            continue;
        }
        let mount = unescape_mount(fields[1]);
        if !mount.starts_with('/') || mount.len() > 255 || mount.contains('\0') {
            continue;
        }
        mounts.insert(mount.clone(), fs_type.to_owned());
    }
    mounts.into_iter().take(16).collect()
}

pub fn statfs_facts(total_blocks: u64, block_size: u64, available_blocks: u64) -> Option<(String, String)> {
    let total = total_blocks.checked_mul(block_size)?;
    let available = available_blocks.checked_mul(block_size)?;
    Some((total.to_string(), available.to_string()))
}

pub fn file_systems(mounts: Vec<(String, String)>, mut facts: impl FnMut(&str) -> Option<(String, String)>) -> Vec<FileSystem> {
    let mut filesystems = Vec::new();
    for (mount, fs_type) in mounts {
        if let Some((total, available)) = facts(&mount) {
            filesystems.push(FileSystem {
                id: mount,
                fs_type,
                total,
                available,
            });
        }
    }
    filesystems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_deltas_and_adjusted_components() {
        let cpu = parse_cpu(b"cpu  100 20 30 400 5 6 7 8 9 10\ncpu0 1 2 3 4\n").unwrap();
        assert_eq!(cpu.user, "120");
        assert_eq!(cpu.system, "43");
        assert_eq!(cpu.idle, "400");
        assert_eq!(cpu.iowait, "5");
        assert_eq!(cpu.steal, "8");
        assert_eq!(cpu.total, "576");
    }

    #[test]
    fn synthetic_cpu_sequence_totals_are_additive() {
        let first = parse_cpu(b"cpu 1000 100 2000 50000 200 10 20 30\n").unwrap();
        let second = parse_cpu(b"cpu 2500 150 2500 63500 300 15 25 40\n").unwrap();
        assert_eq!(second.user.parse::<u64>().unwrap() - first.user.parse::<u64>().unwrap(), 1550);
        assert_eq!(second.system.parse::<u64>().unwrap() - first.system.parse::<u64>().unwrap(), 510);
        assert_eq!(second.idle.parse::<u64>().unwrap() - first.idle.parse::<u64>().unwrap(), 13500);
        assert_eq!(second.iowait.parse::<u64>().unwrap() - first.iowait.parse::<u64>().unwrap(), 100);
        assert_eq!(second.steal.parse::<u64>().unwrap() - first.steal.parse::<u64>().unwrap(), 10);
        assert_eq!(second.total.parse::<u64>().unwrap() - first.total.parse::<u64>().unwrap(), 15670);
    }

    #[test]
    fn rejects_short_or_overflowing_cpu() {
        assert!(parse_cpu(b"cpu 1 2 3\n").is_none());
        assert!(parse_cpu(b"cpu 1 2 3 4 5 6 7 99999999999999999999\n").is_none());
        assert!(parse_cpu(b"cpu0 1 2 3 4\n").is_none());
        assert!(parse_cpu(b"").is_none());
    }

    #[test]
    fn parses_meminfo_available_not_free() {
        let mem = parse_meminfo(b"MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n").unwrap();
        assert_eq!(mem.total, "1024000");
        assert_eq!(mem.available, "614400");
        assert_eq!(mem.swap_total, "204800");
        assert_eq!(mem.swap_free, "51200");
    }

    #[test]
    fn rejects_meminfo_without_available() {
        assert!(parse_meminfo(b"MemTotal: 1000 kB\nMemFree: 10 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n").is_none());
    }

    #[test]
    fn parses_diskstats_whole_disks_only() {
        let whole = HashSet::from(["sda".to_owned(), "dm-0".to_owned()]);
        let text = b"   8       0 sda 10 2 80 1 5 1 40 2 0 7 3 0 0 0 0 0 0\n   8       1 sda1 9 2 70 1 4 1 30 2 0 6 2 0 0 0 0 0 0\n 253       0 dm-0 3 0 24 1 2 0 16 1 0 1 1 0 0 0 0 0 0\n";
        let disks = parse_diskstats(text, &whole).unwrap();
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].id, "253:0");
        assert_eq!(disks[0].read_sectors, "24");
        assert_eq!(disks[1].id, "8:0");
        assert_eq!(disks[1].io_ms, "7");
    }

    #[test]
    fn skips_malformed_disk_lines() {
        let whole = HashSet::from(["sda".to_owned()]);
        let disks = parse_diskstats(b"8 0 sda 1 2 3\n8 0 sda 1 2 x 1 1 1 1 1 1 1 1\n", &whole).unwrap();
        assert!(disks.is_empty());
    }

    #[test]
    fn skips_device_ids_outside_the_linux_dev_t_bounds() {
        let whole = HashSet::from(["sda".to_owned(), "sdb".to_owned(), "sdc".to_owned()]);
        let text = b"4096 0 sda 1 0 1 0 1 0 1 0 0 0 0 0\n8 1048576 sdb 1 0 1 0 1 0 1 0 0 0 0 0\n8 1048575 sdc 1 0 1 0 1 0 1 0 0 0 0 0\n";
        let disks = parse_diskstats(text, &whole).unwrap();
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].id, "8:1048575");
    }

    #[test]
    fn parses_pressure_some_and_full() {
        let group = parse_pressure(b"some avg10=1.25 avg60=0.80 avg300=0.40 total=12345\nfull avg10=0.10 avg60=0.05 avg300=0.02 total=99\n").unwrap();
        assert_eq!(group.some10, "1.25");
        assert_eq!(group.total, "12345");
        assert_eq!(group.full10.as_deref(), Some("0.10"));
        assert_eq!(group.full_total.as_deref(), Some("99"));
    }

    #[test]
    fn rejects_partial_pressure() {
        assert!(parse_pressure(b"some avg10=1.25 avg60=0.80 total=12345\n").is_none());
        assert!(parse_pressure(b"other avg10=1.25 avg60=0.80 avg300=0.40 total=1\n").is_none());
    }

    #[test]
    fn parses_mounts_with_escapes_and_allow_list() {
        let mounts = parse_mounts(b"/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n");
        assert_eq!(mounts, vec![("/".to_owned(), "ext4".to_owned()), ("/mnt/my disk".to_owned(), "xfs".to_owned())]);
    }

    #[test]
    fn fixed_values_are_stable() {
        assert_eq!(fixed3(0), "0.000");
        assert_eq!(fixed3(32_768), "0.500");
        assert_eq!(fixed3(65_536), "1.000");
        assert_eq!(fixed2("100.00").as_deref(), Some("100.00"));
        assert!(fixed2("100").is_none());
        assert!(fixed2("1.234").is_none());
    }

    #[test]
    fn hostile_inputs_do_not_panic() {
        let huge = vec![b'9'; 1_000_000];
        let inputs: [&[u8]; 6] = [b"", b"\0\0\0", &huge, b"cpu \n", b"some avg10=999999999999999999999999.00\n", b"/ / ext4\n"];
        for input in inputs {
            let _ = parse_cpu(input);
            let _ = parse_meminfo(input);
            let _ = parse_diskstats(input, &HashSet::new());
            let _ = parse_pressure(input);
            let _ = parse_mounts(input);
        }
    }

    #[test]
    fn filesystems_skip_statfs_failures() {
        let mounts = vec![("/".to_owned(), "ext4".to_owned()), ("/gone".to_owned(), "xfs".to_owned())];
        let filesystems = file_systems(mounts, |mount| {
            if mount == "/" { Some(("100".to_owned(), "50".to_owned())) } else { None }
        });
        assert_eq!(filesystems.len(), 1);
        assert_eq!(filesystems[0].id, "/");
    }
}
