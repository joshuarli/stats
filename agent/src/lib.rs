pub mod model;
pub mod parse;

#[cfg(target_os = "linux")]
mod linux;

pub use model::Sample;

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
