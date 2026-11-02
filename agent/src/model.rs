use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    Cpu,
    Load,
    Mem,
    Uptime,
    Disks,
    Nets,
    Psi,
    Filesystems,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cpu {
    pub user: String,
    pub system: String,
    pub idle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iowait: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "swapTotal")]
    pub swap_total: String,
    #[serde(rename = "swapFree")]
    pub swap_free: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub swap_activity: Option<SwapActivity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SwapActivity {
    #[serde(rename = "swapIn")]
    pub swap_in: String,
    #[serde(rename = "swapOut")]
    pub swap_out: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CpuInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub threads: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sockets: Option<u32>,
    #[serde(rename = "maxMhz", skip_serializing_if = "Option::is_none")]
    pub max_mhz: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemInfo {
    pub agent: String,
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "readSectors")]
    pub read_sectors: String,
    pub writes: String,
    #[serde(rename = "writeSectors")]
    pub write_sectors: String,
    #[serde(rename = "ioMs", skip_serializing_if = "Option::is_none")]
    pub io_ms: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Net {
    pub id: String,
    #[serde(rename = "rxBytes")]
    pub rx_bytes: String,
    #[serde(rename = "rxPackets")]
    pub rx_packets: String,
    #[serde(rename = "rxDrops")]
    pub rx_drops: String,
    #[serde(rename = "rxErrors")]
    pub rx_errors: String,
    #[serde(rename = "txBytes")]
    pub tx_bytes: String,
    #[serde(rename = "txPackets")]
    pub tx_packets: String,
    #[serde(rename = "txDrops", skip_serializing_if = "Option::is_none")]
    pub tx_drops: Option<String>,
    #[serde(rename = "txErrors")]
    pub tx_errors: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PsiGroup {
    pub some10: String,
    pub some60: String,
    pub some300: String,
    pub total: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full10: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full60: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full300: Option<String>,
    #[serde(rename = "fullTotal", skip_serializing_if = "Option::is_none")]
    pub full_total: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Psi {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<PsiGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<PsiGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "type")]
    pub fs_type: String,
    pub total: String,
    pub available: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Block {
    pub buckets: Vec<String>,
    pub count: String,
    #[serde(rename = "totalUs")]
    pub total_us: String,
    #[serde(rename = "minUs")]
    pub min_us: String,
    #[serde(rename = "maxUs")]
    pub max_us: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sample {
    pub seq: String,
    #[serde(rename = "atMs")]
    pub at_ms: String,
    #[serde(rename = "monoMs")]
    pub mono_ms: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<Unavailable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<Cpu>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<Load>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem: Option<Mem>,
    #[serde(rename = "uptimeMs", skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<String>,
    #[serde(rename = "cpuCount", skip_serializing_if = "Option::is_none")]
    pub cpu_count: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disks: Option<Vec<Disk>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nets: Option<Vec<Net>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psi: Option<Psi>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystems: Option<Vec<FileSystem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<Block>,
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
    }

    pub fn mark_unavailable(&mut self, group: Unavailable) {
        if !self.unavailable.contains(&group) {
            self.unavailable.push(group);
        }
    }
}
