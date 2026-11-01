pub mod backoff;
pub mod block;
pub mod config;
pub mod model;
pub mod parse;
pub mod queue;
pub mod runtime;
pub mod transport;

use model::Sample;

#[cfg(target_os = "linux")]
mod linux;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(target_os = "linux")]
pub fn sample_once() -> Option<Sample> {
    linux::sample()
}

#[cfg(not(target_os = "linux"))]
pub fn sample_once() -> Option<Sample> {
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
