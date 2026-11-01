pub mod backoff;
pub mod block;
pub mod config;
pub mod model;
pub mod parse;
pub mod queue;
pub mod runtime;
pub mod transport;

use model::{Sample, SystemInfo};

#[cfg(target_os = "linux")]
mod linux;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CollectionScope {
    pub virtual_interfaces: bool,
    pub virtual_filesystems: bool,
}

#[cfg(target_os = "linux")]
pub fn sample_once(scope: CollectionScope) -> Option<Sample> {
    linux::sample(scope)
}

#[cfg(not(target_os = "linux"))]
pub fn sample_once(_scope: CollectionScope) -> Option<Sample> {
    None
}

#[cfg(target_os = "linux")]
pub fn system_info() -> Option<SystemInfo> {
    linux::system_info()
}

#[cfg(not(target_os = "linux"))]
pub fn system_info() -> Option<SystemInfo> {
    None
}

#[cfg(target_os = "linux")]
pub fn boot_identity() -> Option<String> {
    linux::boot_identity()
}

#[cfg(not(target_os = "linux"))]
pub fn boot_identity() -> Option<String> {
    None
}
