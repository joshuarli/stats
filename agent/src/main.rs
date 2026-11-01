use stats::config::{load, load_token};
use stats::runtime::{install_signal_handlers, run};
use stats::{sample_once, VERSION};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Serialize)]
struct BenchReport {
    samples: u64,
    interval_ms: u64,
    elapsed_ms: u64,
    collection_ms_total: f64,
    collection_ms_median: f64,
    cpu_user_ms: f64,
    cpu_system_ms: f64,
    max_rss_bytes: u64,
}

fn cpu_times() -> (f64, f64, u64) {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let user = usage.ru_utime.tv_sec as f64 * 1000.0 + usage.ru_utime.tv_usec as f64 / 1000.0;
    let system = usage.ru_stime.tv_sec as f64 * 1000.0 + usage.ru_stime.tv_usec as f64 / 1000.0;
    (user, system, usage.ru_maxrss as u64 * 1024)
}

fn bench(iterations: u32, interval_ms: u64) -> i32 {
    if iterations == 0 || iterations > 1000 || !(100..=3_600_000).contains(&interval_ms) {
        eprintln!("usage: stats --bench <1-1000> <100-3600000 ms>");
        return 2;
    }
    let (user_before, system_before, _) = cpu_times();
    let started = Instant::now();
    let mut collection = Vec::with_capacity(iterations as usize);
    let mut samples = 0_u64;
    for index in 0..iterations {
        let begin = Instant::now();
        if sample_once().is_none() {
            eprintln!("no usable host sample on this platform");
            return 1;
        }
        collection.push(begin.elapsed().as_nanos() as f64 / 1_000_000.0);
        samples += 1;
        if index + 1 < iterations {
            std::thread::sleep(Duration::from_millis(interval_ms));
        }
    }
    let (user_after, system_after, max_rss) = cpu_times();
    let mut sorted = collection.clone();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let report = BenchReport {
        samples,
        interval_ms,
        elapsed_ms: started.elapsed().as_millis() as u64,
        collection_ms_total: collection.iter().sum(),
        collection_ms_median: median,
        cpu_user_ms: user_after - user_before,
        cpu_system_ms: system_after - system_before,
        max_rss_bytes: max_rss,
    };
    match serde_json::to_string_pretty(&report) {
        Ok(text) => {
            println!("{text}");
            0
        }
        Err(error) => {
            eprintln!("could not encode benchmark report: {error}");
            1
        }
    }
}

fn once() -> i32 {
    match sample_once() {
        Some(sample) => match serde_json::to_string_pretty(&sample) {
            Ok(text) => {
                println!("{text}");
                0
            }
            Err(error) => {
                eprintln!("could not encode sample: {error}");
                1
            }
        },
        None => {
            eprintln!("no usable host sample on this platform");
            1
        }
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let status = match arguments.as_slice() {
        [flag] if flag == "--version" => {
            println!("stats {VERSION}");
            0
        }
        [flag] if flag == "--once" => once(),
        [flag, iterations, interval] if flag == "--bench" => {
            let parsed_iterations = iterations.parse::<u32>().ok();
            let parsed_interval = interval.parse::<u64>().ok();
            match (parsed_iterations, parsed_interval) {
                (Some(iterations), Some(interval)) => bench(iterations, interval),
                _ => {
                    eprintln!("usage: stats --bench <1-1000> <100-3600000 ms>");
                    2
                }
            }
        }
        [flag, path] if flag == "--config" => {
            let config = match load(Path::new(path)) {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            let token = match load_token(&config) {
                Ok(token) => token,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            if let Err(error) = install_signal_handlers() {
                eprintln!("{error}");
                std::process::exit(1);
            }
            match run(&config, token) {
                Ok(report) => {
                    eprintln!(
                        "telemetry stopped: sampled={} sample_failures={} accepted={} duplicates={} rejected_by_server={} dropped_local={} upload_failures={}",
                        report.sampled, report.sample_failures, report.accepted, report.duplicates, report.rejected_by_server, report.dropped_local, report.upload_failures
                    );
                    0
                }
                Err(error) => {
                    eprintln!("{error}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: stats --config <path> | --once | --bench <iterations> <interval_ms> | --version");
            2
        }
    };
    std::process::exit(status);
}
