use deser::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cpu {
    pub user: String,
    pub system: String,
    pub idle: String,
    #[deser(skip_serializing_if = Option::is_none)]
    pub iowait: Option<String>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub steal: Option<String>,
    pub total: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Load {
    pub one: String,
    pub five: String,
    pub fifteen: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mem {
    pub total: String,
    pub available: String,
    #[deser(rename = "swapTotal")]
    pub swap_total: String,
    #[deser(rename = "swapFree")]
    pub swap_free: String,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub swap_activity: Option<SwapActivity>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub pressure: Option<MemoryPressure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[deser(rename_all = "snake_case")]
pub enum MemoryPressure {
    Normal,
    Warn,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SwapActivity {
    #[deser(rename = "swapIn")]
    pub swap_in: String,
    #[deser(rename = "swapOut")]
    pub swap_out: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CpuInfo {
    #[deser(skip_serializing_if = Option::is_none)]
    pub model: Option<String>,
    pub threads: u32,
    #[deser(skip_serializing_if = Option::is_none)]
    pub cores: Option<u32>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub sockets: Option<u32>,
    #[deser(rename = "maxMhz", skip_serializing_if = Option::is_none)]
    pub max_mhz: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemInfo {
    pub agent: String,
    pub hostname: String,
    #[deser(skip_serializing_if = Option::is_none)]
    pub os: Option<String>,
    pub kernel: String,
    pub arch: String,
    pub cpu: CpuInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Disk {
    pub id: String,
    pub name: String,
    pub reads: String,
    #[deser(rename = "readSectors")]
    pub read_sectors: String,
    pub writes: String,
    #[deser(rename = "writeSectors")]
    pub write_sectors: String,
    #[deser(rename = "ioMs", skip_serializing_if = Option::is_none)]
    pub io_ms: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Net {
    pub id: String,
    #[deser(rename = "rxBytes")]
    pub rx_bytes: String,
    #[deser(rename = "rxPackets")]
    pub rx_packets: String,
    #[deser(rename = "rxDrops")]
    pub rx_drops: String,
    #[deser(rename = "rxErrors")]
    pub rx_errors: String,
    #[deser(rename = "txBytes")]
    pub tx_bytes: String,
    #[deser(rename = "txPackets")]
    pub tx_packets: String,
    #[deser(rename = "txDrops", skip_serializing_if = Option::is_none)]
    pub tx_drops: Option<String>,
    #[deser(rename = "txErrors")]
    pub tx_errors: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PsiGroup {
    pub some10: String,
    pub some60: String,
    pub some300: String,
    pub total: String,
    #[deser(skip_serializing_if = Option::is_none)]
    pub full10: Option<String>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub full60: Option<String>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub full300: Option<String>,
    #[deser(rename = "fullTotal", skip_serializing_if = Option::is_none)]
    pub full_total: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Psi {
    #[deser(skip_serializing_if = Option::is_none)]
    pub cpu: Option<PsiGroup>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub memory: Option<PsiGroup>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub io: Option<PsiGroup>,
}

impl Psi {
    pub fn is_empty(&self) -> bool {
        self.cpu.is_none() && self.memory.is_none() && self.io.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileSystem {
    pub id: String,
    #[deser(rename = "type")]
    pub fs_type: String,
    pub total: String,
    pub available: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gpu {
    pub active: String,
    pub total: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Power {
    #[deser(rename = "gpuNj", skip_serializing_if = Option::is_none)]
    pub gpu_nj: Option<String>,
    #[deser(flatten, skip_serializing_if = Option::is_none)]
    pub system: Option<SystemPower>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemPower {
    #[deser(rename = "systemMwSum")]
    pub milliwatt_sum: String,
    #[deser(rename = "systemReadings")]
    pub readings: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Block {
    pub buckets: Vec<String>,
    pub count: String,
    #[deser(rename = "totalUs")]
    pub total_us: String,
    #[deser(rename = "minUs")]
    pub min_us: String,
    #[deser(rename = "maxUs")]
    pub max_us: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sample {
    pub seq: String,
    #[deser(rename = "atMs")]
    pub at_ms: String,
    #[deser(rename = "monoMs")]
    pub mono_ms: String,
    #[deser(skip_serializing_if = Vec::is_empty)]
    pub unavailable: Vec<Unavailable>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub cpu: Option<Cpu>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub load: Option<Load>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub mem: Option<Mem>,
    #[deser(rename = "uptimeMs", skip_serializing_if = Option::is_none)]
    pub uptime_ms: Option<String>,
    #[deser(rename = "cpuCount", skip_serializing_if = Option::is_none)]
    pub cpu_count: Option<u16>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub disks: Option<Vec<Disk>>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub nets: Option<Vec<Net>>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub psi: Option<Psi>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub filesystems: Option<Vec<FileSystem>>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub block: Option<Block>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub gpu: Option<Gpu>,
    #[deser(skip_serializing_if = Option::is_none)]
    pub power: Option<Power>,
}

pub fn sequence_for(mono_ms: u64) -> u64 {
    mono_ms / 1000
}

impl Sample {
    pub fn empty(seq: u64, at_ms: u64, mono_ms: u64) -> Self {
        Self {
            seq: seq.to_string(),
            at_ms: at_ms.to_string(),
            mono_ms: mono_ms.to_string(),
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
    }

    pub fn mark_unavailable(&mut self, group: Unavailable) {
        if !self.unavailable.contains(&group) {
            self.unavailable.push(group);
        }
    }
}
