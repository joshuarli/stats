#![cfg(all(target_os = "linux", feature = "block-latency"))]

use stats::block_bpf::Probe;

#[test]
fn the_probe_counts_block_io() {
    let mut probe = match Probe::load() {
        Some(probe) => probe,
        None => panic!("the BPF probe did not load"),
    };

    let path = std::env::temp_dir().join("stats-block-probe-io");
    std::fs::write(&path, [0xABu8; 256 * 1024]).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.sync_all().unwrap();
    drop(file);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let block = probe.poll().expect("the probe returned no block");
        if block.count > 0 {
            assert!(block.max_us >= block.min_us);
            assert!(block.count == block.buckets.iter().sum::<u64>());
            return;
        }
        if std::time::Instant::now() >= deadline {
            panic!("the probe counted no completions while sync I/O was in flight");
        }
    }
}
