use deser::Deserialize;
use stats::model::{BootId, HostId, Sample, SystemInfo};
use stats::wire::{self, Delta, MAX_BODY};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

struct Counting;

static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED.fetch_add(size as u64, Ordering::Relaxed);
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[derive(Deserialize)]
struct Source {
    #[deser(rename = "hostId")]
    host_id: String,
    #[deser(rename = "bootId")]
    boot_id: String,
    #[deser(default)]
    system: Option<SystemInfo>,
    samples: Vec<Sample>,
}

const WORKLOADS: [&str; 9] = ["linux-normal", "macos-normal", "linux-single", "macos-single", "system", "linux-backlog-16", "macos-backlog-16", "high-cardinality-16", "u64-boundaries"];
const ROUNDS: usize = 15;
const ITERATIONS: usize = 2_000;

fn allocations(work: &mut dyn FnMut() -> usize) -> (u64, u64, usize) {
    let count = ALLOCATIONS.load(Ordering::Relaxed);
    let bytes = ALLOCATED.load(Ordering::Relaxed);
    let size = work();
    (ALLOCATIONS.load(Ordering::Relaxed) - count, ALLOCATED.load(Ordering::Relaxed) - bytes, size)
}

fn interleaved(workers: &mut [(&str, Box<dyn FnMut() -> usize + '_>)]) -> Vec<Vec<f64>> {
    for (_, work) in workers.iter_mut() {
        for _ in 0..200 {
            black_box(work());
        }
    }
    let mut rounds = vec![Vec::with_capacity(ROUNDS); workers.len()];
    for _ in 0..ROUNDS {
        for (index, (_, work)) in workers.iter_mut().enumerate() {
            let started = Instant::now();
            for _ in 0..ITERATIONS {
                black_box(work());
            }
            rounds[index].push(started.elapsed().as_nanos() as f64 / ITERATIONS as f64);
        }
    }
    rounds.iter_mut().for_each(|values| values.sort_by(f64::total_cmp));
    rounds
}

fn max_rss_kib() -> i64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if cfg!(target_os = "macos") { usage.ru_maxrss / 1024 } else { usage.ru_maxrss }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/v2/sources");
    println!("encoder | workload | samples | bytes | ns/op median [min-max] | allocations/op | allocated bytes/op");
    for name in WORKLOADS {
        let text = std::fs::read_to_string(root.join(format!("{name}.json"))).unwrap();
        let source: Source = deser_json::from_str(&text).unwrap();
        let host: HostId = source.host_id.parse().unwrap();
        let boot: BootId = source.boot_id.parse().unwrap();
        let system = source.system.as_ref();
        let samples = source.samples.as_slice();
        let mut encoders: [(&str, Box<dyn FnMut() -> usize>); 2] = [
            ("stb2", Box::new(|| wire::encode_batch(&host, &boot, system, samples, MAX_BODY).unwrap().body.len())),
            ("stb2-absolute", Box::new(|| wire::encode_batch_with(&host, &boot, system, samples, MAX_BODY, Delta::AbsoluteOnly).unwrap().body.len())),
        ];
        let counts: Vec<(u64, u64, usize)> = encoders.iter_mut().map(|(_, work)| allocations(work.as_mut())).collect();
        let rounds = interleaved(&mut encoders);
        for (index, (label, _)) in encoders.iter().enumerate() {
            let (count, bytes, size) = counts[index];
            let values = &rounds[index];
            println!("{label} | {name} | {} | {size} | {:.0} [{:.0}-{:.0}] | {count} | {bytes}", samples.len(), values[ROUNDS / 2], values[0], values[ROUNDS - 1]);
        }
    }
    println!("max RSS of this benchmark process: {} KiB", max_rss_kib());
}
