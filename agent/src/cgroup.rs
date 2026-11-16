use crate::model::{Service, ServiceIo, ServiceMemory, ServiceUsage};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const ROOT: &str = "/sys/fs/cgroup";

const CPU_STAT_LIMIT: usize = 4_096;
const IO_STAT_LIMIT: usize = 65_536;
const VALUE_LIMIT: usize = 64;
const UNIT_LIMIT: usize = 128;

fn valid_unit(unit: &str) -> bool {
    let bytes = unit.as_bytes();
    !bytes.is_empty() && bytes.len() <= UNIT_LIMIT && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b'-'))
}

pub fn unit_cgroup(unit: &str) -> Option<PathBuf> {
    if !valid_unit(unit) {
        return None;
    }
    if let Some(name) = unit.strip_prefix("openrc.") {
        return (!name.is_empty()).then(|| PathBuf::from(unit));
    }
    if let Some(stem) = unit.strip_suffix(".scope") {
        let runtime_slice = if stem.starts_with("libpod-") || stem.starts_with("machine-") { "machine.slice" } else { "system.slice" };
        return (!stem.is_empty() && !stem.contains('@')).then(|| Path::new(runtime_slice).join(unit));
    }
    if let Some(stem) = unit.strip_suffix(".slice") {
        if stem.is_empty() || stem.starts_with('-') || stem.ends_with('-') || stem.contains("--") || stem.contains('@') {
            return None;
        }
        let mut path = PathBuf::new();
        let mut end = 0;
        for part in stem.split('-') {
            end += part.len();
            path.push(format!("{}.slice", &stem[..end]));
            end += 1;
        }
        return Some(path);
    }
    let stem = unit.strip_suffix(".service").filter(|stem| !stem.is_empty())?;
    match stem.split_once('@') {
        None => Some(Path::new("system.slice").join(unit)),
        Some((template, instance)) if !template.is_empty() && !instance.contains('@') => {
            Some(Path::new("system.slice").join(format!("system-{}.slice", template.replace('-', "\\x2d"))).join(unit))
        }
        Some(_) => None,
    }
}

fn parse_value(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    text.parse().ok()
}

pub fn parse_cpu_usage(bytes: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(bytes).ok()?;
    text.lines().find_map(|line| line.strip_prefix("usage_usec ")).and_then(|value| parse_value(value.trim()))
}

fn device_id(text: &str) -> Option<String> {
    let (major, minor) = text.split_once(':')?;
    let major = major.parse::<u32>().ok()?;
    let minor = minor.parse::<u32>().ok()?;
    let id = format!("{major}:{minor}");
    (id == text).then_some(id)
}

fn io_devices(bytes: &[u8]) -> Option<Vec<(String, ServiceIo)>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut devices = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if devices.len() >= 256 { return None; }
        let mut fields = line.split_whitespace();
        let id = device_id(fields.next()?)?;
        if devices.iter().any(|(existing, _)| existing == &id) { return None; }
        let mut device = [None; 4];
        for field in fields {
            let (key, value) = field.split_once('=')?;
            let slot = match key {
                "rbytes" => 0,
                "wbytes" => 1,
                "rios" => 2,
                "wios" => 3,
                _ => continue,
            };
            if device[slot].is_some() { return None; }
            device[slot] = Some(parse_value(value)?);
        }
        let [read_bytes, write_bytes, reads, writes] = device;
        devices.push((id, ServiceIo { read_bytes: read_bytes?, write_bytes: write_bytes?, reads: reads?, writes: writes? }));
    }
    Some(devices)
}

fn sum_io(devices: impl Iterator<Item = ServiceIo>) -> Option<ServiceIo> {
    let mut total = ServiceIo { read_bytes: 0, write_bytes: 0, reads: 0, writes: 0 };
    for device in devices {
        total.read_bytes = total.read_bytes.checked_add(device.read_bytes)?;
        total.write_bytes = total.write_bytes.checked_add(device.write_bytes)?;
        total.reads = total.reads.checked_add(device.reads)?;
        total.writes = total.writes.checked_add(device.writes)?;
    }
    Some(total)
}

pub fn parse_io_stat(bytes: &[u8]) -> Option<ServiceIo> {
    sum_io(io_devices(bytes)?.into_iter().map(|(_, io)| io))
}

fn read_io_stat(bytes: &[u8], block_root: &Path) -> Option<ServiceIo> {
    let devices = io_devices(bytes)?;
    let mut excluded = std::collections::HashSet::new();
    for (id, _) in &devices {
        let mut pending = vec![id.clone()];
        let mut visited = std::collections::HashSet::new();
        while let Some(current) = pending.pop() {
            if !visited.insert(current.clone()) { continue; }
            if visited.len() > 256 { return None; }
            for entry in std::fs::read_dir(block_root.join(&current).join("holders")).ok()? {
                let bytes = read_bounded(&entry.ok()?.path().join("dev"), VALUE_LIMIT)?;
                let holder = device_id(std::str::from_utf8(&bytes).ok()?.trim())?;
                if holder == *id { return None; }
                excluded.insert(holder.clone());
                pending.push(holder);
            }
        }
    }
    sum_io(devices.into_iter().filter(|(id, _)| !excluded.contains(id)).map(|(_, io)| io))
}

fn read_bounded(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut buffer = Vec::with_capacity(limit.min(VALUE_LIMIT * 4));
    File::open(path).ok()?.take(limit as u64 + 1).read_to_end(&mut buffer).ok()?;
    (buffer.len() <= limit).then_some(buffer)
}

fn read_value(path: &Path) -> Option<u64> {
    let bytes = read_bounded(path, VALUE_LIMIT)?;
    parse_value(std::str::from_utf8(&bytes).ok()?.trim())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceCgroup {
    pub name: String,
    pub cgroup: PathBuf,
}

fn read_usage(directory: &Path, devices: &Path) -> Option<ServiceUsage> {
    let cpu_usec = parse_cpu_usage(&read_bounded(&directory.join("cpu.stat"), CPU_STAT_LIMIT)?)?;
    let memory = read_value(&directory.join("memory.current")).map(|current| ServiceMemory { current, peak: read_value(&directory.join("memory.peak")) });
    let io = read_bounded(&directory.join("io.stat"), IO_STAT_LIMIT).and_then(|bytes| read_io_stat(&bytes, devices));
    Some(ServiceUsage { cpu_usec, memory, io })
}

pub struct CgroupRoots<'a> {
    pub cgroups: &'a Path,
    pub devices: &'a Path,
}

pub fn read_services(roots: CgroupRoots<'_>, services: &[ServiceCgroup]) -> Option<Vec<Service>> {
    read_bounded(&roots.cgroups.join("cgroup.controllers"), VALUE_LIMIT * 4)?;
    Some(
        services
            .iter()
            .map(|service| match read_usage(&roots.cgroups.join(&service.cgroup), roots.devices) {
                Some(usage) => Service::measured(&service.name, usage),
                None => Service::unavailable(&service.name),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch;
    use std::fs;

    #[test]
    fn units_map_to_the_cgroup_their_manager_creates() {
        let path = |unit: &str| unit_cgroup(unit).map(|path| path.display().to_string());
        assert_eq!(path("nginx.service").as_deref(), Some("system.slice/nginx.service"));
        assert_eq!(path("getty@tty1.service").as_deref(), Some("system.slice/system-getty.slice/getty@tty1.service"));
        assert_eq!(path("systemd-fsck@dev-sda1.service").as_deref(), Some("system.slice/system-systemd\\x2dfsck.slice/systemd-fsck@dev-sda1.service"));
        assert_eq!(path("docker-0123abcd.scope").as_deref(), Some("system.slice/docker-0123abcd.scope"));
        assert_eq!(path("libpod-0123abcd.scope").as_deref(), Some("machine.slice/libpod-0123abcd.scope"));
        assert_eq!(path("machine-web.scope").as_deref(), Some("machine.slice/machine-web.scope"));
        assert_eq!(path("stats.slice").as_deref(), Some("stats.slice"));
        assert_eq!(path("stats-node.slice").as_deref(), Some("stats.slice/stats-node.slice"));
        assert_eq!(path("a-b-c.slice").as_deref(), Some("a.slice/a-b.slice/a-b-c.slice"));
        assert_eq!(path("openrc.tansu").as_deref(), Some("openrc.tansu"));
        assert_eq!(path("openrc.tansu-http-redirect").as_deref(), Some("openrc.tansu-http-redirect"));
        for invalid in ["", "nginx", "nginx.socket", ".service", "../x.service", "a/b.service", "@x.service", "a@b@c.service", "x@y.scope", ".scope", ".slice", "-.slice", "-a.slice", "a-.slice", "a--b.slice", "a@b.slice", "openrc."] {
            assert_eq!(unit_cgroup(invalid), None, "{invalid}");
        }
        assert_eq!(unit_cgroup(&format!("{}.service", "a".repeat(121))), None);
    }

    #[test]
    fn io_stat_sums_every_device_and_an_empty_file_is_zero_io() {
        let io = parse_io_stat(b"8:0 rbytes=4096 wbytes=8192 rios=1 wios=2 dbytes=0 dios=0\n259:0 rbytes=1 wbytes=2 rios=3 wios=4 dbytes=5 dios=6\n").unwrap();
        assert_eq!(io, ServiceIo { read_bytes: 4097, write_bytes: 8194, reads: 4, writes: 6 });
        assert_eq!(parse_io_stat(b""), Some(ServiceIo { read_bytes: 0, write_bytes: 0, reads: 0, writes: 0 }));
        assert_eq!(parse_io_stat(b"8:0 rbytes=1 wbytes=2 rios=3\n"), None);
        assert_eq!(parse_io_stat(b"8:0 rbytes=18446744073709551615 wbytes=0 rios=0 wios=0\n8:16 rbytes=1 wbytes=0 rios=0 wios=0\n"), None);
        assert_eq!(parse_cpu_usage(b"usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n"), Some(123_456));
        assert_eq!(parse_cpu_usage(b"user_usec 1\n"), None);
    }

    #[test]
    fn a_missing_cgroup_or_controller_is_unavailable_or_absent_never_zero() {
        let root = scratch("cgroup");
        let service = |name: &str, unit: &str| ServiceCgroup { name: name.into(), cgroup: unit_cgroup(unit).unwrap() };
        let services = [service("web", "web.service"), service("db", "db.service"), service("gone", "gone.service")];
        assert_eq!(read_services(CgroupRoots { cgroups: &root, devices: &root }, &services), None);

        fs::write(root.join("cgroup.controllers"), "cpuset cpu io memory pids\n").unwrap();
        let web = root.join("system.slice/web.service");
        fs::create_dir_all(&web).unwrap();
        fs::write(web.join("cpu.stat"), "usage_usec 5000\nuser_usec 4000\nsystem_usec 1000\n").unwrap();
        fs::write(web.join("memory.current"), "1048576\n").unwrap();
        fs::write(web.join("memory.peak"), "2097152\n").unwrap();
        fs::write(web.join("io.stat"), "").unwrap();
        let db = root.join("system.slice/db.service");
        fs::create_dir_all(&db).unwrap();
        fs::write(db.join("cpu.stat"), "usage_usec 7\n").unwrap();

        let read = read_services(CgroupRoots { cgroups: &root, devices: &root }, &services).unwrap();
        assert_eq!(read[0], Service::measured("web", ServiceUsage { cpu_usec: 5000, memory: Some(ServiceMemory { current: 1_048_576, peak: Some(2_097_152) }), io: Some(ServiceIo { read_bytes: 0, write_bytes: 0, reads: 0, writes: 0 }) }));
        assert_eq!(read[1], Service::measured("db", ServiceUsage { cpu_usec: 7, memory: None, io: None }));
        assert_eq!(read[2], Service::unavailable("gone"));
    }
    #[test]
    fn stacked_io_counts_backing_devices_once_through_unlisted_intermediate_layers() {
        let root = scratch("io-topology");
        for id in ["8:0", "8:16", "253:0", "253:1"] { fs::create_dir_all(root.join(id).join("holders")).unwrap(); }
        let holder = |device: &str, name: &str, id: &str| {
            let path = root.join(device).join("holders").join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("dev"), id).unwrap();
        };
        holder("8:0", "dm-0", "253:0");
        holder("8:16", "dm-0", "253:0");
        holder("253:0", "dm-1", "253:1");
        let stats = b"8:0 rbytes=100 wbytes=200 rios=1 wios=2\n8:16 rbytes=300 wbytes=400 rios=3 wios=4\n253:1 rbytes=400 wbytes=600 rios=4 wios=6\n";
        assert_eq!(read_io_stat(stats, &root), Some(ServiceIo { read_bytes: 400, write_bytes: 600, reads: 4, writes: 6 }));
        assert_eq!(read_io_stat(b"253:1 rbytes=400 wbytes=600 rios=4 wios=6\n", &root), Some(ServiceIo { read_bytes: 400, write_bytes: 600, reads: 4, writes: 6 }));
        assert_eq!(read_io_stat(b"../x:0 rbytes=1 wbytes=2 rios=3 wios=4\n", &root), None);
        assert_eq!(read_io_stat(b"8:0 rbytes=1 wbytes=2 rios=3 wios=4\n8:0 rbytes=1 wbytes=2 rios=3 wios=4\n", &root), None);
        fs::remove_file(root.join("253:0/holders/dm-1/dev")).unwrap();
        assert_eq!(read_io_stat(stats, &root), None);
    }

    #[test]
    fn a_measured_device_mapper_write_is_not_counted_twice() {
        let root = scratch("measured-io-topology");
        fs::create_dir_all(root.join("7:0/holders/dm-0")).unwrap();
        fs::write(root.join("7:0/holders/dm-0/dev"), "252:0").unwrap();
        fs::create_dir_all(root.join("252:0/holders")).unwrap();
        let bytes = include_bytes!("../tests/fixtures/stacked-io.stat");
        assert_eq!(parse_io_stat(bytes).unwrap().write_bytes, 8_388_608);
        assert_eq!(read_io_stat(bytes, &root), Some(ServiceIo { read_bytes: 0, write_bytes: 4_194_304, reads: 0, writes: 4 }));
    }

}
