use deser::adapters::DisplayFromStr;
use deser::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

pub const BLOCK_BUCKETS: usize = 16;
pub const FILESYSTEM_TYPES: [&str; 13] = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay", "apfs"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[deser(rename_all = "snake_case")]
pub enum Unavailable {
    Cpu,
    Load,
    Mem,
    Uptime,
    Disks,
    Nets,
    Psi,
    Filesystems,
    Gpu,
    Power,
    Services,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidValue;

impl fmt::Display for InvalidValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid value")
    }
}

impl std::error::Error for InvalidValue {}

fn canonical_decimal(text: &str, max_digits: usize) -> Option<u64> {
    if text.is_empty() || text.len() > max_digits || !text.bytes().all(|byte| byte.is_ascii_digit()) || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    text.parse().ok()
}

fn fixed_point(text: &str, digits: usize, scale: u64) -> Result<u64, InvalidValue> {
    let (whole, fraction) = text.split_once('.').ok_or(InvalidValue)?;
    let whole = canonical_decimal(whole, 16).ok_or(InvalidValue)?;
    if fraction.len() != digits || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(InvalidValue);
    }
    let fraction: u64 = fraction.parse().map_err(|_| InvalidValue)?;
    whole.checked_mul(scale).and_then(|value| value.checked_add(fraction)).ok_or(InvalidValue)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Thousandths(pub u64);

impl fmt::Display for Thousandths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{:03}", self.0 / 1000, self.0 % 1000)
    }
}

impl FromStr for Thousandths {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        fixed_point(text, 3, 1000).map(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Hundredths(pub u64);

impl fmt::Display for Hundredths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{:02}", self.0 / 100, self.0 % 100)
    }
}

impl FromStr for Hundredths {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        fixed_point(text, 2, 100).map(Self)
    }
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn hex_bytes(digits: impl Iterator<Item = u8>) -> Option<[u8; 16]> {
    let digits: Vec<u8> = digits.collect();
    if digits.len() != 32 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    for (index, pair) in digits.chunks_exact(2).enumerate() {
        bytes[index] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostId(pub [u8; 16]);

impl FromStr for HostId {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        let digits = text.strip_prefix("h_").ok_or(InvalidValue)?;
        hex_bytes(digits.bytes()).map(Self).ok_or(InvalidValue)
    }
}

impl fmt::Display for HostId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("h_")?;
        self.0.iter().try_for_each(|byte| write!(formatter, "{byte:02x}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootId(pub [u8; 16]);

impl FromStr for BootId {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        let shaped = text.len() == 36 && text.bytes().enumerate().all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) == (byte == b'-'));
        if !shaped {
            return Err(InvalidValue);
        }
        hex_bytes(text.bytes().filter(|byte| *byte != b'-')).map(Self).ok_or(InvalidValue)
    }
}

impl fmt::Display for BootId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, byte) in self.0.iter().enumerate() {
            if matches!(index, 4 | 6 | 8 | 10) {
                formatter.write_str("-")?;
            }
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DiskId {
    pub major: u32,
    pub minor: u32,
}

pub const DISK_MAJOR_MAX: u32 = 4_095;
pub const DISK_MINOR_MAX: u32 = 1_048_575;

impl DiskId {
    pub fn new(major: u64, minor: u64) -> Option<Self> {
        let major = u32::try_from(major).ok().filter(|major| *major <= DISK_MAJOR_MAX)?;
        let minor = u32::try_from(minor).ok().filter(|minor| *minor <= DISK_MINOR_MAX)?;
        Some(Self { major, minor })
    }
}

impl fmt::Display for DiskId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.major, self.minor)
    }
}

impl FromStr for DiskId {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        let (major, minor) = text.split_once(':').ok_or(InvalidValue)?;
        let major = canonical_decimal(major, 4).ok_or(InvalidValue)?;
        let minor = canonical_decimal(minor, 7).ok_or(InvalidValue)?;
        Self::new(major, minor).ok_or(InvalidValue)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileSystemType(u8);

impl FileSystemType {
    pub fn from_name(name: &str) -> Option<Self> {
        FILESYSTEM_TYPES.iter().position(|known| *known == name).and_then(|index| u8::try_from(index).ok()).map(Self)
    }

    pub fn name(self) -> &'static str {
        FILESYSTEM_TYPES[usize::from(self.0)]
    }

    pub fn wire(self) -> u8 {
        self.0
    }
}

impl fmt::Display for FileSystemType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

impl FromStr for FileSystemType {
    type Err = InvalidValue;
    fn from_str(text: &str) -> Result<Self, InvalidValue> {
        Self::from_name(text).ok_or(InvalidValue)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Cpu {
    #[deser(as = DisplayFromStr)]
    pub user: u64,
    #[deser(as = DisplayFromStr)]
    pub system: u64,
    #[deser(as = DisplayFromStr)]
    pub idle: u64,
    #[deser(as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub iowait: Option<u64>,
    #[deser(as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub steal: Option<u64>,
    #[deser(as = DisplayFromStr)]
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Load {
    #[deser(as = DisplayFromStr)]
    pub one: Thousandths,
    #[deser(as = DisplayFromStr)]
    pub five: Thousandths,
    #[deser(as = DisplayFromStr)]
    pub fifteen: Thousandths,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mem {
    #[deser(as = DisplayFromStr)]
    pub total: u64,
    #[deser(as = DisplayFromStr)]
    pub available: u64,
    #[deser(rename = "swapTotal", as = DisplayFromStr)]
    pub swap_total: u64,
    #[deser(rename = "swapFree", as = DisplayFromStr)]
    pub swap_free: u64,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub swap_activity: Option<SwapActivity>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub pressure: Option<MemoryPressure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[deser(rename_all = "snake_case")]
pub enum MemoryPressure {
    Normal,
    Warn,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapActivity {
    #[deser(rename = "swapIn", as = DisplayFromStr)]
    pub swap_in: u64,
    #[deser(rename = "swapOut", as = DisplayFromStr)]
    pub swap_out: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct CpuInfo {
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub model: Option<String>,
    pub threads: u32,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub cores: Option<u32>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub sockets: Option<u32>,
    #[deser(rename = "maxMhz", default, skip_serializing_if = Option::is_none)]
    pub max_mhz: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct SystemInfo {
    pub agent: String,
    pub hostname: String,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub os: Option<String>,
    pub kernel: String,
    pub arch: String,
    pub cpu: CpuInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Disk {
    #[deser(as = DisplayFromStr)]
    pub id: DiskId,
    pub name: String,
    #[deser(as = DisplayFromStr)]
    pub reads: u64,
    #[deser(rename = "readSectors", as = DisplayFromStr)]
    pub read_sectors: u64,
    #[deser(as = DisplayFromStr)]
    pub writes: u64,
    #[deser(rename = "writeSectors", as = DisplayFromStr)]
    pub write_sectors: u64,
    #[deser(rename = "ioMs", as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub io_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Net {
    pub id: String,
    #[deser(rename = "rxBytes", as = DisplayFromStr)]
    pub rx_bytes: u64,
    #[deser(rename = "rxPackets", as = DisplayFromStr)]
    pub rx_packets: u64,
    #[deser(rename = "rxDrops", as = DisplayFromStr)]
    pub rx_drops: u64,
    #[deser(rename = "rxErrors", as = DisplayFromStr)]
    pub rx_errors: u64,
    #[deser(rename = "txBytes", as = DisplayFromStr)]
    pub tx_bytes: u64,
    #[deser(rename = "txPackets", as = DisplayFromStr)]
    pub tx_packets: u64,
    #[deser(rename = "txDrops", as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub tx_drops: Option<u64>,
    #[deser(rename = "txErrors", as = DisplayFromStr)]
    pub tx_errors: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct PsiFull {
    #[deser(rename = "full10", as = DisplayFromStr)]
    pub avg10: Hundredths,
    #[deser(rename = "full60", as = DisplayFromStr)]
    pub avg60: Hundredths,
    #[deser(rename = "full300", as = DisplayFromStr)]
    pub avg300: Hundredths,
    #[deser(rename = "fullTotal", as = DisplayFromStr)]
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PsiGroup {
    #[deser(as = DisplayFromStr)]
    pub some10: Hundredths,
    #[deser(as = DisplayFromStr)]
    pub some60: Hundredths,
    #[deser(as = DisplayFromStr)]
    pub some300: Hundredths,
    #[deser(as = DisplayFromStr)]
    pub total: u64,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub full: Option<PsiFull>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Psi {
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub cpu: Option<PsiGroup>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub memory: Option<PsiGroup>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub io: Option<PsiGroup>,
}

impl Psi {
    pub fn is_empty(&self) -> bool {
        self.cpu.is_none() && self.memory.is_none() && self.io.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct FileSystem {
    pub id: String,
    #[deser(rename = "type", as = DisplayFromStr)]
    pub fs_type: FileSystemType,
    #[deser(as = DisplayFromStr)]
    pub total: u64,
    #[deser(as = DisplayFromStr)]
    pub available: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Gpu {
    #[deser(as = DisplayFromStr)]
    pub active: u64,
    #[deser(as = DisplayFromStr)]
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Power {
    #[deser(rename = "gpuNj", as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub gpu_nj: Option<u64>,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub system: Option<SystemPower>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemPower {
    #[deser(rename = "systemMwSum", as = DisplayFromStr)]
    pub milliwatt_sum: u64,
    #[deser(rename = "systemReadings", as = DisplayFromStr)]
    pub readings: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Block {
    #[deser(as = [DisplayFromStr; BLOCK_BUCKETS])]
    pub buckets: [u64; BLOCK_BUCKETS],
    #[deser(as = DisplayFromStr)]
    pub count: u64,
    #[deser(rename = "totalUs", as = DisplayFromStr)]
    pub total_us: u64,
    #[deser(rename = "minUs", as = DisplayFromStr)]
    pub min_us: u64,
    #[deser(rename = "maxUs", as = DisplayFromStr)]
    pub max_us: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceMemory {
    #[deser(rename = "memoryCurrent", as = DisplayFromStr)]
    pub current: u64,
    #[deser(rename = "memoryPeak", as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub peak: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceIo {
    #[deser(rename = "ioReadBytes", as = DisplayFromStr)]
    pub read_bytes: u64,
    #[deser(rename = "ioWriteBytes", as = DisplayFromStr)]
    pub write_bytes: u64,
    #[deser(rename = "ioReads", as = DisplayFromStr)]
    pub reads: u64,
    #[deser(rename = "ioWrites", as = DisplayFromStr)]
    pub writes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceUsage {
    #[deser(rename = "cpuUsec", as = DisplayFromStr)]
    pub cpu_usec: u64,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub memory: Option<ServiceMemory>,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub io: Option<ServiceIo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeasuredService {
    pub name: String,
    #[deser(flatten)]
    pub usage: ServiceUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct UnavailableService {
    pub name: String,
    pub unavailable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(untagged)]
pub enum Service {
    Unavailable(UnavailableService),
    Measured(MeasuredService),
}

impl Service {
    pub fn measured(name: &str, usage: ServiceUsage) -> Self {
        Self::Measured(MeasuredService { name: name.to_owned(), usage })
    }

    pub fn unavailable(name: &str) -> Self {
        Self::Unavailable(UnavailableService { name: name.to_owned(), unavailable: true })
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Unavailable(service) => &service.name,
            Self::Measured(service) => &service.name,
        }
    }

    pub fn usage(&self) -> Option<&ServiceUsage> {
        match self {
            Self::Unavailable(_) => None,
            Self::Measured(service) => Some(&service.usage),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[deser(deny_unknown_fields)]
pub struct Sample {
    #[deser(as = DisplayFromStr)]
    pub seq: u64,
    #[deser(rename = "atMs", as = DisplayFromStr)]
    pub at_ms: u64,
    #[deser(rename = "monoMs", as = DisplayFromStr)]
    pub mono_ms: u64,
    #[deser(default, skip_serializing_if = Vec::is_empty)]
    pub unavailable: Vec<Unavailable>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub cpu: Option<Cpu>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub load: Option<Load>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub mem: Option<Mem>,
    #[deser(rename = "uptimeMs", as = Option<DisplayFromStr>, default, skip_serializing_if = Option::is_none)]
    pub uptime_ms: Option<u64>,
    #[deser(rename = "cpuCount", default, skip_serializing_if = Option::is_none)]
    pub cpu_count: Option<u16>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub disks: Option<Vec<Disk>>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub nets: Option<Vec<Net>>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub psi: Option<Psi>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub filesystems: Option<Vec<FileSystem>>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub block: Option<Block>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub gpu: Option<Gpu>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub power: Option<Power>,
    #[deser(default, skip_serializing_if = Option::is_none)]
    pub services: Option<Vec<Service>>,
}

pub fn sequence_for(mono_ms: u64) -> u64 {
    mono_ms / 1000
}

impl Sample {
    pub fn empty(seq: u64, at_ms: u64, mono_ms: u64) -> Self {
        Self {
            seq,
            at_ms,
            mono_ms,
            unavailable: Vec::new(),
            cpu: None,
            load: None,
            mem: None,
            uptime_ms: None,
            cpu_count: None,
            disks: None,
            nets: None,
            psi: None,
            filesystems: None,
            block: None,
            gpu: None,
            power: None,
            services: None,
        }
    }

    pub fn has_metrics(&self) -> bool {
        self.cpu.is_some()
            || self.load.is_some()
            || self.mem.is_some()
            || self.uptime_ms.is_some()
            || self.disks.is_some()
            || self.nets.is_some()
            || self.psi.is_some()
            || self.filesystems.is_some()
            || self.block.is_some()
            || self.gpu.is_some()
            || self.power.is_some()
            || self.services.is_some()
    }

    pub fn mark_unavailable(&mut self, group: Unavailable) {
        if !self.unavailable.contains(&group) {
            self.unavailable.push(group);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_round_trip_through_their_wire_bytes() {
        let host: HostId = "h_0123456789abcdef0123456789abcdef".parse().unwrap();
        assert_eq!(host.0, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
        assert_eq!(host.to_string(), "h_0123456789abcdef0123456789abcdef");
        let boot: BootId = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f".parse().unwrap();
        assert_eq!(boot.0[..4], [0x3f, 0x2a, 0x9c, 0x1e]);
        assert_eq!(boot.0[15], 0x6f);
        assert_eq!(boot.to_string(), "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f");
        for invalid in ["3f2a9c1e8b7d-4c6a-9e5f-1a2b3c4d5e6f0", "3F2A9C1E-8B7D-4C6A-9E5F-1A2B3C4D5E6F", "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6"] {
            assert!(invalid.parse::<BootId>().is_err(), "{invalid}");
        }
        assert!("h_0123".parse::<HostId>().is_err());
    }

    #[test]
    fn fixed_point_text_is_exact_and_canonical() {
        assert_eq!("0.120".parse::<Thousandths>(), Ok(Thousandths(120)));
        assert_eq!("999999.999".parse::<Thousandths>(), Ok(Thousandths(999_999_999)));
        assert_eq!(Thousandths(5).to_string(), "0.005");
        assert_eq!("1.25".parse::<Hundredths>(), Ok(Hundredths(125)));
        assert_eq!(Hundredths(10_000).to_string(), "100.00");
        assert_eq!("1000000.000".parse::<Thousandths>(), Ok(Thousandths(1_000_000_000)));
        for invalid in ["01.000", "1.00", "1.0000", ".120", "12345678901234567.000", "-1.000"] {
            assert!(invalid.parse::<Thousandths>().is_err(), "{invalid}");
        }
    }

    #[test]
    fn disk_ids_keep_the_linux_dev_t_bounds() {
        assert_eq!("8:1048575".parse::<DiskId>(), Ok(DiskId { major: 8, minor: 1_048_575 }));
        assert!("4096:0".parse::<DiskId>().is_err());
        assert!("8:1048576".parse::<DiskId>().is_err());
        assert!("08:0".parse::<DiskId>().is_err());
    }
}
