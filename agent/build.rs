use std::env;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_BLOCK_LATENCY").is_none() || env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() != "linux" {
        return;
    }
    let root = Path::new(&env::var_os("CARGO_MANIFEST_DIR").unwrap()).parent().unwrap().to_path_buf();
    let path = env::var("STATS_BLOCK_PROBE").map(PathBuf::from).unwrap_or_else(|_| root.join(".work/bpf/block_latency.bpf.o"));
    if !path.is_file() {
        panic!("feature block-latency requires the BPF object at {}; build it with agent/scripts/build-probe.sh (needs the LLVM release with the BPF backend)", path.display());
    }
    println!("cargo:rustc-env=STATS_BLOCK_PROBE={}", path.display());
    println!("cargo:rerun-if-changed={}", path.display());
}
