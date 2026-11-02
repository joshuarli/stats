use crate::model::{Cpu, CpuInfo, Disk, FileSystem, Mem, Psi, PsiGroup, SwapActivity};
use std::collections::{BTreeMap, BTreeSet, HashSet};

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
        iowait: Some(iowait.to_string()),
        steal: Some(steal.to_string()),
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
        swap_activity: None,
    })
}

pub fn clean_text(text: &str, limit: usize) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let printable: String = collapsed.chars().filter(|character| !character.is_control()).take(limit).collect();
    if printable.is_empty() { None } else { Some(printable) }
}

pub fn parse_os_release(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let raw = line.strip_prefix(key)?.strip_prefix('=')?;
            clean_text(raw.trim().trim_matches(|character| character == '"' || character == '\''), 128)
        })
    };
    value("PRETTY_NAME").or_else(|| value("NAME"))
}

pub fn parse_cpuinfo(bytes: &[u8], max_mhz: Option<u32>) -> Option<CpuInfo> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut threads = 0_u32;
    let mut model = None;
    let mut sockets = BTreeSet::new();
    let mut cores = BTreeSet::new();
    let mut physical: Option<String> = None;
    let mut core: Option<String> = None;
    let mut counted = false;
    let mut finish = |physical: &mut Option<String>, core: &mut Option<String>, counted: &mut bool, threads: &mut u32| {
        if *counted {
            *threads += 1;
        }
        if let Some(socket) = physical.take() {
            if let Some(core) = core.take() {
                cores.insert((socket.clone(), core));
            }
            sockets.insert(socket);
        }
        *core = None;
        *counted = false;
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            if line.trim().is_empty() {
                finish(&mut physical, &mut core, &mut counted, &mut threads);
            }
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "processor" => counted = true,
            "physical id" => physical = Some(value.to_owned()),
            "core id" => core = Some(value.to_owned()),
            "model name" | "Model" | "Hardware" if model.is_none() => model = clean_text(value, 128),
            _ => {}
        }
    }
    finish(&mut physical, &mut core, &mut counted, &mut threads);
    if threads == 0 {
        return None;
    }
    let count = |value: usize| u32::try_from(value).ok().filter(|count| *count > 0);
    Some(CpuInfo { model, threads, cores: count(cores.len()), sockets: count(sockets.len()), max_mhz })
}

pub fn parse_vmstat_swap(bytes: &[u8], page_size: u64) -> Option<SwapActivity> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut swapped_in = None;
    let mut swapped_out = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(' ') else { continue };
        match key {
            "pswpin" => swapped_in = parse_u64(value),
            "pswpout" => swapped_out = parse_u64(value),
            _ => {}
        }
    }
    Some(SwapActivity {
        swap_in: swapped_in?.checked_mul(page_size)?.to_string(),
        swap_out: swapped_out?.checked_mul(page_size)?.to_string(),
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

pub const FILESYSTEM_TYPES: [&str; 13] = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay", "apfs"];

const VIRTUAL_FILESYSTEM_TYPES: [&str; 2] = ["tmpfs", "overlay"];

pub fn parse_mounts(bytes: &[u8], include_virtual: bool) -> Vec<(String, String)> {
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
        if !FILESYSTEM_TYPES.contains(&fs_type) || (!include_virtual && VIRTUAL_FILESYSTEM_TYPES.contains(&fs_type)) {
            continue;
        }
        let mount = unescape_mount(fields[1]);
        if !mount.starts_with('/') || mount.len() > 255 || mount.contains('\0') {
            continue;
        }
        mounts.insert(mount, (fs_type.to_owned(), fields[0].to_owned()));
    }
    let mut block_devices = HashSet::new();
    mounts
        .into_iter()
        .filter(|(_, (_, device))| !device.starts_with('/') || block_devices.insert(device.clone()))
        .map(|(mount, (fs_type, _))| (mount, fs_type))
        .take(16)
        .collect()
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
        assert_eq!(cpu.iowait.as_deref(), Some("5"));
        assert_eq!(cpu.steal.as_deref(), Some("8"));
        assert_eq!(cpu.total, "576");
    }

    #[test]
    fn synthetic_cpu_sequence_totals_are_additive() {
        let first = parse_cpu(b"cpu 1000 100 2000 50000 200 10 20 30\n").unwrap();
        let second = parse_cpu(b"cpu 2500 150 2500 63500 300 15 25 40\n").unwrap();
        assert_eq!(second.user.parse::<u64>().unwrap() - first.user.parse::<u64>().unwrap(), 1550);
        assert_eq!(second.system.parse::<u64>().unwrap() - first.system.parse::<u64>().unwrap(), 510);
        assert_eq!(second.idle.parse::<u64>().unwrap() - first.idle.parse::<u64>().unwrap(), 13500);
        assert_eq!(second.iowait.as_deref().unwrap().parse::<u64>().unwrap() - first.iowait.as_deref().unwrap().parse::<u64>().unwrap(), 100);
        assert_eq!(second.steal.as_deref().unwrap().parse::<u64>().unwrap() - first.steal.as_deref().unwrap().parse::<u64>().unwrap(), 10);
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
    fn swap_activity_is_pages_times_page_size_and_needs_both_counters() {
        let activity = parse_vmstat_swap(b"nr_free_pages 5\npswpin 10\npswpout 3\npgfault 9\n", 4096).unwrap();
        assert_eq!((activity.swap_in.as_str(), activity.swap_out.as_str()), ("40960", "12288"));
        assert!(parse_vmstat_swap(b"pswpin 10\n", 4096).is_none());
        assert!(parse_vmstat_swap(b"pswpin 10\npswpout x\n", 4096).is_none());
        assert!(parse_vmstat_swap(b"pswpin 18446744073709551615\npswpout 1\n", 4096).is_none());
    }

    #[test]
    fn cpuinfo_counts_threads_cores_and_sockets_from_the_topology_lines() {
        let two_sockets = "processor\t: 0\nmodel name\t: AMD  EPYC 9654\nphysical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 1\nmodel name\t: AMD  EPYC 9654\nphysical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 2\nmodel name\t: AMD  EPYC 9654\nphysical id\t: 1\ncore id\t\t: 0\n\nprocessor\t: 3\nmodel name\t: AMD  EPYC 9654\nphysical id\t: 1\ncore id\t\t: 1\n";
        let info = parse_cpuinfo(two_sockets.as_bytes(), Some(3700)).unwrap();
        assert_eq!(info, CpuInfo { model: Some("AMD EPYC 9654".to_owned()), threads: 4, cores: Some(3), sockets: Some(2), max_mhz: Some(3700) });
    }

    #[test]
    fn cpuinfo_without_topology_reports_only_what_it_has() {
        let arm = "processor\t: 0\nBogoMIPS\t: 50.00\n\nprocessor\t: 1\nBogoMIPS\t: 50.00\n\nHardware\t: BCM2835\n";
        let info = parse_cpuinfo(arm.as_bytes(), None).unwrap();
        assert_eq!(info, CpuInfo { model: Some("BCM2835".to_owned()), threads: 2, cores: None, sockets: None, max_mhz: None });
        assert!(parse_cpuinfo(b"model name\t: nothing\n", None).is_none());
        assert!(parse_cpuinfo(&[0xff, 0xfe], None).is_none());
    }

    #[test]
    fn os_release_prefers_the_pretty_name_and_strips_quotes() {
        assert_eq!(parse_os_release(b"NAME=\"Alpine Linux\"\nPRETTY_NAME=\"Alpine Linux edge\"\n").as_deref(), Some("Alpine Linux edge"));
        assert_eq!(parse_os_release(b"ID=x\nNAME='Plain'\n").as_deref(), Some("Plain"));
        assert!(parse_os_release(b"ID=x\n").is_none());
    }

    #[test]
    fn parses_mounts_with_escapes_and_allow_list() {
        let mounts = parse_mounts(b"/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n", false);
        assert_eq!(mounts, vec![("/".to_owned(), "ext4".to_owned()), ("/mnt/my disk".to_owned(), "xfs".to_owned())]);
    }

    #[test]
    fn mounts_of_one_block_device_are_reported_once_under_the_shortest_path() {
        let table = b"/dev/nvme0n1p2 /var/lib/docker ext4 rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p1 /boot/efi vfat rw 0 0\ntank/data /srv zfs rw 0 0\ntank/logs /var/log zfs rw 0 0\n";
        let mounts = parse_mounts(table, false);
        assert_eq!(mounts.iter().map(|(mount, _)| mount.as_str()).collect::<Vec<_>>(), ["/", "/boot/efi", "/srv", "/var/log"]);
    }

    #[test]
    fn virtual_filesystems_are_opt_in_and_never_crowd_out_real_ones() {
        let mut table = String::from("/dev/sda1 / ext4 rw 0 0\n");
        for index in 0..20 {
            table.push_str(&format!("overlay /a/overlay{index} overlay rw 0 0\n"));
        }
        table.push_str("tmpfs /dev/shm tmpfs rw 0 0\n/dev/sdb1 /zdata xfs rw 0 0\n");
        let default = parse_mounts(table.as_bytes(), false);
        assert_eq!(default, vec![("/".to_owned(), "ext4".to_owned()), ("/zdata".to_owned(), "xfs".to_owned())]);
        let everything = parse_mounts(table.as_bytes(), true);
        assert_eq!(everything.len(), 16);
        assert!(everything.iter().any(|(_, kind)| kind == "overlay"));
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
            let _ = parse_mounts(input, false);
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
