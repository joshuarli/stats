pub mod backoff;
pub mod block;
pub mod cgroup;
pub mod config;
pub mod model;
pub mod parse;
pub mod queue;
pub mod runtime;
pub mod transport;
pub mod wire;

use model::{Sample, SystemInfo};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(test)]
mod test_support;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CollectionScope {
    pub virtual_interfaces: bool,
    pub virtual_filesystems: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn sample_once(scope: CollectionScope) -> Option<Sample> {
    platform::sample(scope)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn sample_once(_scope: CollectionScope) -> Option<Sample> {
    None
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn system_info() -> Option<SystemInfo> {
    platform::system_info()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn system_info() -> Option<SystemInfo> {
    None
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn boot_identity() -> Option<String> {
    platform::boot_identity()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn boot_identity() -> Option<String> {
    None
}
