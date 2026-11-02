use crate::CollectionScope;
use crate::model::{sequence_for, Cpu, CpuInfo, FileSystem, Load, Mem, Net, Sample, SwapActivity, SystemInfo, Unavailable};
use crate::parse::{clean_text, file_systems, statfs_facts, FILESYSTEM_TYPES};
use std::ffi::{CStr, CString};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

mod iokit;

const MAX_DEVICES: usize = 16;
const DATA_VOLUME: &str = "/System/Volumes/Data";
const IFT_ETHER: u8 = 0x06;

unsafe extern "C" {
    fn mach_host_self() -> libc::mach_port_t;
    static mach_task_self_: libc::mach_port_t;
}

fn host_port() -> libc::mach_port_t {
    static PORT: OnceLock<libc::mach_port_t> = OnceLock::new();
    *PORT.get_or_init(|| unsafe { mach_host_self() })
}

fn sysctl_raw(name: &str, value: *mut libc::c_void, size: &mut libc::size_t) -> Option<()> {
    let name = CString::new(name).ok()?;
    (unsafe { libc::sysctlbyname(name.as_ptr(), value, size, std::ptr::null_mut(), 0) } == 0).then_some(())
}

fn sysctl_value<T: Copy>(name: &str) -> Option<T> {
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut size = std::mem::size_of::<T>();
    sysctl_raw(name, value.as_mut_ptr().cast(), &mut size)?;
    (size == std::mem::size_of::<T>()).then(|| unsafe { value.assume_init() })
}

fn sysctl_string(name: &str) -> Option<String> {
    let mut size: libc::size_t = 0;
    sysctl_raw(name, std::ptr::null_mut(), &mut size)?;
    if size == 0 || size > 4096 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    sysctl_raw(name, buffer.as_mut_ptr().cast(), &mut size)?;
    buffer.truncate(size);
    let text = CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok()?;
    Some(text.to_owned())
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

fn boot_uuid(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    let valid = value.len() == 36
        && value.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_hexdigit(),
        });
    valid.then_some(value)
}

pub fn boot_identity() -> Option<String> {
    boot_uuid(&sysctl_string("kern.bootsessionuuid")?)
}

fn cpu_from_ticks(per_cpu: &[[u32; 4]]) -> Option<Cpu> {
    let mut user = 0u64;
    let mut system = 0u64;
    let mut idle = 0u64;
    for ticks in per_cpu {
        user = user.checked_add(u64::from(ticks[libc::CPU_STATE_USER as usize]))?.checked_add(u64::from(ticks[libc::CPU_STATE_NICE as usize]))?;
        system = system.checked_add(u64::from(ticks[libc::CPU_STATE_SYSTEM as usize]))?;
        idle = idle.checked_add(u64::from(ticks[libc::CPU_STATE_IDLE as usize]))?;
    }
    let total = user.checked_add(system)?.checked_add(idle)?;
    Some(Cpu { user: user.to_string(), system: system.to_string(), idle: idle.to_string(), iowait: None, steal: None, total: total.to_string() })
}

fn read_cpu() -> Option<Cpu> {
    let mut count: libc::natural_t = 0;
    let mut info: libc::processor_info_array_t = std::ptr::null_mut();
    let mut info_count: libc::mach_msg_type_number_t = 0;
    let status = unsafe { libc::host_processor_info(host_port(), libc::PROCESSOR_CPU_LOAD_INFO, &mut count, &mut info, &mut info_count) };
    if status != libc::KERN_SUCCESS || info.is_null() {
        return None;
    }
    let states = libc::CPU_STATE_MAX as usize;
    let words = info_count as usize;
    let per_cpu: Vec<[u32; 4]> = if words == count as usize * states {
        let values = unsafe { std::slice::from_raw_parts(info.cast::<u32>(), words) };
        values.chunks_exact(states).map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]]).collect()
    } else {
        Vec::new()
    };
    let bytes = words * std::mem::size_of::<libc::integer_t>();
    unsafe { libc::vm_deallocate(mach_task_self_, info as libc::vm_address_t, bytes as libc::vm_size_t) };
    if per_cpu.is_empty() {
        return None;
    }
    cpu_from_ticks(&per_cpu)
}

fn fixed3(value: f64) -> Option<String> {
    (value.is_finite() && (0.0..1_000_000.0).contains(&value)).then(|| format!("{value:.3}"))
}

fn read_load() -> Option<Load> {
    let mut values = [0f64; 3];
    if unsafe { libc::getloadavg(values.as_mut_ptr(), 3) } != 3 {
        return None;
    }
    Some(Load { one: fixed3(values[0])?, five: fixed3(values[1])?, fifteen: fixed3(values[2])? })
}

struct PageCounts {
    internal: u64,
    purgeable: u64,
    wired: u64,
    compressed: u64,
}

fn available_bytes(total: u64, pages: &PageCounts, page_size: u64) -> u64 {
    let used_pages = pages.internal.saturating_sub(pages.purgeable).saturating_add(pages.wired).saturating_add(pages.compressed);
    total.saturating_sub(used_pages.saturating_mul(page_size))
}

fn read_mem() -> Option<Mem> {
    let total: u64 = sysctl_value("hw.memsize")?;
    let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok().filter(|size| *size > 0)?;
    let mut stats: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let status = unsafe { libc::host_statistics64(host_port(), libc::HOST_VM_INFO64, (&mut stats as *mut libc::vm_statistics64).cast(), &mut count) };
    if status != libc::KERN_SUCCESS {
        return None;
    }
    let pages = PageCounts {
        internal: u64::from(stats.internal_page_count),
        purgeable: u64::from(stats.purgeable_count),
        wired: u64::from(stats.wire_count),
        compressed: u64::from(stats.compressor_page_count),
    };
    let swap: libc::xsw_usage = sysctl_value("vm.swapusage")?;
    Some(Mem {
        total: total.to_string(),
        available: available_bytes(total, &pages, page_size).to_string(),
        swap_total: swap.xsu_total.to_string(),
        swap_free: swap.xsu_avail.to_string(),
        swap_activity: Some(SwapActivity {
            swap_in: stats.swapins.checked_mul(page_size)?.to_string(),
            swap_out: stats.swapouts.checked_mul(page_size)?.to_string(),
        }),
    })
}

fn read_uptime_ms(now_ms: u64) -> Option<String> {
    let boot: libc::timeval = sysctl_value("kern.boottime")?;
    let boot_ms = u64::try_from(boot.tv_sec).ok()?.checked_mul(1000)?.checked_add(u64::try_from(boot.tv_usec).ok()? / 1000)?;
    Some(now_ms.checked_sub(boot_ms)?.to_string())
}

fn cpu_count() -> Option<u16> {
    let online = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    (1..=4096).contains(&online).then(|| u16::try_from(online).ok()).flatten()
}

struct Interface {
    name: String,
    ethernet: bool,
    rx_bytes: u64,
    rx_packets: u64,
    rx_drops: u64,
    rx_errors: u64,
    tx_bytes: u64,
    tx_packets: u64,
    tx_errors: u64,
}

fn physical_interface(name: &str, ethernet: bool) -> bool {
    ethernet && name.starts_with("en")
}

fn valid_ifname(name: &str) -> bool {
    !name.is_empty() && name.len() <= 15 && name != "lo0" && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-'))
}

fn select_interfaces(mut candidates: Vec<(String, bool)>, include_virtual: bool) -> Vec<String> {
    candidates.retain(|(name, ethernet)| valid_ifname(name) && (include_virtual || physical_interface(name, *ethernet)));
    candidates.sort_by(|(left, left_ethernet), (right, right_ethernet)| {
        physical_interface(right, *right_ethernet).cmp(&physical_interface(left, *left_ethernet)).then_with(|| left.cmp(right))
    });
    candidates.dedup_by(|left, right| left.0 == right.0);
    candidates.into_iter().map(|(name, _)| name).take(MAX_DEVICES).collect()
}

fn sysctl_mib<T: Copy>(mib: &mut [libc::c_int]) -> Option<T> {
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut size = std::mem::size_of::<T>();
    let status = unsafe { libc::sysctl(mib.as_mut_ptr(), u32::try_from(mib.len()).ok()?, value.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
    (status == 0 && size == std::mem::size_of::<T>()).then(|| unsafe { value.assume_init() })
}

fn interface_table() -> Option<Vec<Interface>> {
    let count: libc::c_uint = sysctl_mib(&mut [libc::CTL_NET, libc::PF_LINK, libc::NETLINK_GENERIC, libc::IFMIB_SYSTEM, libc::IFMIB_IFCOUNT])?;
    let mut interfaces = Vec::new();
    for index in 1..=count {
        let row = libc::c_int::try_from(index).ok()?;
        let Some(entry) = sysctl_mib::<libc::ifmibdata>(&mut [libc::CTL_NET, libc::PF_LINK, libc::NETLINK_GENERIC, libc::IFMIB_IFDATA, row, libc::IFDATA_GENERAL]) else { continue };
        let Some(name) = c_text(&entry.ifmd_name) else { continue };
        let data = entry.ifmd_data;
        interfaces.push(Interface {
            name,
            ethernet: data.ifi_type == IFT_ETHER,
            rx_bytes: data.ifi_ibytes,
            rx_packets: data.ifi_ipackets,
            rx_drops: data.ifi_iqdrops,
            rx_errors: data.ifi_ierrors,
            tx_bytes: data.ifi_obytes,
            tx_packets: data.ifi_opackets,
            tx_errors: data.ifi_oerrors,
        });
    }
    Some(interfaces)
}

fn read_nets(include_virtual: bool) -> Option<Vec<Net>> {
    let interfaces = interface_table()?;
    let chosen = select_interfaces(interfaces.iter().map(|interface| (interface.name.clone(), interface.ethernet)).collect(), include_virtual);
    Some(
        chosen
            .iter()
            .filter_map(|name| interfaces.iter().find(|interface| &interface.name == name))
            .map(|interface| Net {
                id: interface.name.clone(),
                rx_bytes: interface.rx_bytes.to_string(),
                rx_packets: interface.rx_packets.to_string(),
                rx_drops: interface.rx_drops.to_string(),
                rx_errors: interface.rx_errors.to_string(),
                tx_bytes: interface.tx_bytes.to_string(),
                tx_packets: interface.tx_packets.to_string(),
                tx_drops: None,
                tx_errors: interface.tx_errors.to_string(),
            })
            .collect(),
    )
}

struct Mount {
    path: String,
    fs_type: String,
    local: bool,
    read_only: bool,
    browsable: bool,
}

fn select_mounts(mounts: Vec<Mount>, include_virtual: bool) -> Vec<(String, String)> {
    let mut chosen: Vec<(String, String)> = mounts
        .into_iter()
        .filter(|mount| {
            mount.local
                && !mount.read_only
                && FILESYSTEM_TYPES.contains(&mount.fs_type.as_str())
                && (include_virtual || mount.browsable || mount.path == DATA_VOLUME)
                && mount.path.starts_with('/')
                && mount.path.len() <= 255
        })
        .map(|mount| (mount.path, mount.fs_type))
        .collect();
    chosen.sort();
    chosen.dedup_by(|left, right| left.0 == right.0);
    chosen.truncate(MAX_DEVICES);
    chosen
}

fn c_text(field: &[libc::c_char]) -> Option<String> {
    let bytes: Vec<u8> = field.iter().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect();
    String::from_utf8(bytes).ok()
}

fn mount_table() -> Option<Vec<libc::statfs>> {
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    let capacity = usize::try_from(count).ok()?;
    let mut table: Vec<libc::statfs> = vec![unsafe { std::mem::zeroed() }; capacity];
    let bytes = libc::c_int::try_from(capacity * std::mem::size_of::<libc::statfs>()).ok()?;
    let filled = unsafe { libc::getfsstat(table.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    table.truncate(usize::try_from(filled).ok()?);
    Some(table)
}

fn read_filesystems(include_virtual: bool) -> Option<Vec<FileSystem>> {
    let table = mount_table()?;
    let mounts = table
        .iter()
        .filter_map(|entry| {
            let flags = entry.f_flags as i32;
            Some(Mount {
                path: c_text(&entry.f_mntonname)?,
                fs_type: c_text(&entry.f_fstypename)?,
                local: flags & libc::MNT_LOCAL != 0,
                read_only: flags & libc::MNT_RDONLY != 0,
                browsable: flags & libc::MNT_DONTBROWSE == 0,
            })
        })
        .collect();
    let chosen = select_mounts(mounts, include_virtual);
    if chosen.is_empty() {
        return Some(Vec::new());
    }
    let facts = |path: &str| {
        let entry = table.iter().find(|entry| c_text(&entry.f_mntonname).as_deref() == Some(path))?;
        statfs_facts(entry.f_blocks, u64::from(entry.f_bsize), entry.f_bavail)
    };
    let filesystems = file_systems(chosen, facts);
    if filesystems.is_empty() { None } else { Some(filesystems) }
}

fn uname_field(field: &[libc::c_char], limit: usize) -> Option<String> {
    clean_text(&c_text(field)?, limit)
}

fn bounded_u32(name: &str, high: u32) -> Option<u32> {
    let value: i32 = sysctl_value(name)?;
    u32::try_from(value).ok().filter(|value| (1..=high).contains(value))
}

pub fn system_info() -> Option<SystemInfo> {
    let mut name: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut name) } != 0 {
        return None;
    }
    let os = sysctl_string("kern.osproductversion").and_then(|version| clean_text(&format!("macOS {version}"), 128));
    Some(SystemInfo {
        agent: crate::VERSION.to_owned(),
        hostname: uname_field(&name.nodename, 64)?,
        os,
        kernel: uname_field(&name.release, 64)?,
        arch: uname_field(&name.machine, 16)?,
        cpu: CpuInfo {
            model: sysctl_string("machdep.cpu.brand_string").and_then(|model| clean_text(&model, 128)),
            threads: bounded_u32("hw.logicalcpu", 4096)?,
            cores: bounded_u32("hw.physicalcpu", 4096),
            sockets: bounded_u32("hw.packages", 256),
            max_mhz: None,
        },
    })
}

pub fn sample(scope: CollectionScope) -> Option<Sample> {
    let mono_ms = monotonic_ms()?;
    let at_ms = wall_ms()?;
    let mut sample = Sample::empty(sequence_for(mono_ms), at_ms, mono_ms);

    match read_cpu() {
        Some(cpu) => sample.cpu = Some(cpu),
        None => sample.mark_unavailable(Unavailable::Cpu),
    }
    match read_mem() {
        Some(mem) => sample.mem = Some(mem),
        None => sample.mark_unavailable(Unavailable::Mem),
    }
    match read_load() {
        Some(load) => sample.load = Some(load),
        None => sample.mark_unavailable(Unavailable::Load),
    }
    match read_uptime_ms(at_ms) {
        Some(uptime) => sample.uptime_ms = Some(uptime),
        None => sample.mark_unavailable(Unavailable::Uptime),
    }
    sample.cpu_count = cpu_count();
    match iokit::read_disks(MAX_DEVICES) {
        Some(disks) => sample.disks = Some(disks),
        None => sample.mark_unavailable(Unavailable::Disks),
    }
    sample.mark_unavailable(Unavailable::Psi);
    match read_nets(scope.virtual_interfaces) {
        Some(nets) => sample.nets = Some(nets),
        None => sample.mark_unavailable(Unavailable::Nets),
    }
    match read_filesystems(scope.virtual_filesystems) {
        Some(filesystems) => sample.filesystems = Some(filesystems),
        None => sample.mark_unavailable(Unavailable::Filesystems),
    }

    sample.has_metrics().then_some(sample)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mount(path: &str, fs_type: &str, read_only: bool, browsable: bool) -> Mount {
        Mount { path: path.into(), fs_type: fs_type.into(), local: true, read_only, browsable }
    }

    #[test]
    fn the_data_volume_and_browsable_writable_volumes_are_reported() {
        let mounts = vec![
            mount("/", "apfs", true, true),
            mount("/System/Volumes/VM", "apfs", false, false),
            mount("/System/Volumes/Data", "apfs", false, false),
            mount("/dev", "devfs", false, false),
            mount("/Volumes/Backup", "apfs", false, true),
            Mount { path: "/Volumes/Share".into(), fs_type: "smbfs".into(), local: false, read_only: false, browsable: true },
        ];
        assert_eq!(select_mounts(mounts, false), [("/System/Volumes/Data".to_owned(), "apfs".to_owned()), ("/Volumes/Backup".to_owned(), "apfs".to_owned())]);
    }

    #[test]
    fn hidden_system_volumes_appear_only_when_virtual_filesystems_are_included() {
        let mounts = vec![mount("/System/Volumes/VM", "apfs", false, false), mount("/System/Volumes/Data", "apfs", false, false)];
        assert_eq!(select_mounts(mounts, true).len(), 2);
    }

    #[test]
    fn ethernet_ports_come_first_and_tunnels_need_virtual_interfaces() {
        let candidates = || vec![("utun0".to_owned(), false), ("en1".to_owned(), true), ("lo0".to_owned(), false), ("bridge0".to_owned(), true), ("en0".to_owned(), true)];
        assert_eq!(select_interfaces(candidates(), false), ["en0", "en1"]);
        assert_eq!(select_interfaces(candidates(), true), ["en0", "en1", "bridge0", "utun0"]);
    }

    #[test]
    fn available_memory_excludes_app_wired_and_compressed_pages_but_not_purgeable_ones() {
        let pages = PageCounts { internal: 100, purgeable: 10, wired: 20, compressed: 30 };
        assert_eq!(available_bytes(1_000 * 4096, &pages, 4096), (1_000 - 140) * 4096);
        let overcommitted = PageCounts { internal: 2_000, purgeable: 0, wired: 0, compressed: 0 };
        assert_eq!(available_bytes(1_000 * 4096, &overcommitted, 4096), 0);
    }

    #[test]
    fn cpu_ticks_fold_nice_into_user_and_report_no_iowait_or_steal() {
        let cpu = cpu_from_ticks(&[[10, 5, 70, 2], [u32::MAX, 0, 0, 0]]).unwrap();
        assert_eq!(cpu.user, (12 + u64::from(u32::MAX)).to_string());
        assert_eq!(cpu.system, "5");
        assert_eq!(cpu.idle, "70");
        assert_eq!(cpu.total, (87 + u64::from(u32::MAX)).to_string());
        assert_eq!((cpu.iowait, cpu.steal), (None, None));
    }

    #[test]
    fn the_boot_session_uuid_is_lowercased_to_the_wire_shape() {
        assert_eq!(boot_uuid("4113F1BB-0511-4B93-B7FB-E0F5489AA3DE\n").as_deref(), Some("4113f1bb-0511-4b93-b7fb-e0f5489aa3de"));
        assert_eq!(boot_uuid("not-a-uuid"), None);
    }
}
