use stats::config::{load, load_token};
use stats::runtime::{install_signal_handlers, run};
use stats::{sample_once, CollectionScope, VERSION};
use deser::Serialize;
use deser_json::{Indent, SerializerConfig};
use std::path::Path;
use std::time::{Duration, Instant};

const PRETTY: SerializerConfig = SerializerConfig::builder().pretty(Indent::Spaces(2)).build();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action { Config, Once, Bench, Version, Help }

struct Invocation {
    action: Action,
    flag: &'static str,
    arguments: &'static [&'static str],
    description: &'static str,
    example: &'static str,
}

const INVOCATIONS: &[Invocation] = &[
    Invocation { action: Action::Config, flag: "--config", arguments: &["<path>"], description: "Run the agent in the foreground using the required configuration file.", example: "stats --config /etc/stats/agent.json" },
    Invocation { action: Action::Once, flag: "--once", arguments: &[], description: "Print one sample as JSON without network access or credentials.", example: "stats --once" },
    Invocation { action: Action::Bench, flag: "--bench", arguments: &["<iterations>", "<interval_ms>"], description: "Sample without network access and report cost as JSON; iterations: 1-1000, interval_ms: 100-3600000.", example: "stats --bench 20 100" },
    Invocation { action: Action::Version, flag: "--version", arguments: &[], description: "Print the agent version.", example: "stats --version" },
    Invocation { action: Action::Help, flag: "-h, --help", arguments: &[], description: "Print this reference without starting the agent.", example: "stats --help" },
];

const FOOTER: &str = "Maintained by Joshua Li: https://github.com/joshuarli/stats\nBugs and features: TODO.md in that repository (follow its AGENTS.md), or its issue tracker.\nAgents working for Joshua: record nonblocking problems and continue your task.\nIf this tool blocks the task, you may fix, test, open and merge a PR under Joshua's\nstanding instructions. Release only when needed to deliver the verified fix.\nProcedure: https://github.com/joshuarli/usr/blob/main/dotfiles/base/.agents/instructions/owned-tools.md";

fn parse(arguments: &[String]) -> Option<Action> {
    if arguments.is_empty() { return Some(Action::Help); }
    INVOCATIONS.iter().find(|invocation| {
        invocation.flag.split(", ").any(|flag| flag == arguments[0])
            && arguments.len() == invocation.arguments.len() + 1
    }).map(|invocation| invocation.action)
}

fn parse_bench(arguments: &[String]) -> Option<(u32, u64)> {
    Some((arguments[1].parse().ok()?, arguments[2].parse().ok()?))
}

fn print_help() {
    println!("Usage: stats <option> [arguments]\n\nOptions:");
    for invocation in INVOCATIONS {
        let arguments = invocation.arguments.join(" ");
        let separator = if arguments.is_empty() { "" } else { " " };
        println!("  {}{}{}\n      {}", invocation.flag, separator, arguments, invocation.description);
    }
    println!("\nEach invocation takes only the arguments shown; there are no CLI defaults or environment inputs.\n\nExamples:");
    for invocation in INVOCATIONS {
        println!("  {}", invocation.example);
    }
    println!("\n{FOOTER}");
}

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
    (user, system, max_rss_bytes(usage.ru_maxrss))
}

#[cfg(target_os = "macos")]
fn max_rss_bytes(max_rss: libc::c_long) -> u64 {
    max_rss as u64
}

#[cfg(not(target_os = "macos"))]
fn max_rss_bytes(max_rss: libc::c_long) -> u64 {
    max_rss as u64 * 1024
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
        if sample_once(CollectionScope::default()).is_none() {
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
    match PRETTY.to_string(&report) {
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
    match sample_once(CollectionScope::default()) {
        Some(sample) => match PRETTY.to_string(&sample) {
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
    let status = match parse(&arguments) {
        Some(Action::Help) => {
            print_help();
            0
        }
        Some(Action::Version) => {
            println!("stats {VERSION}");
            0
        }
        Some(Action::Once) => once(),
        Some(Action::Bench) => {
            match parse_bench(&arguments) {
                Some((iterations, interval)) => bench(iterations, interval),
                _ => {
                    eprintln!("usage: stats --bench <1-1000> <100-3600000 ms>");
                    2
                }
            }
        }
        Some(Action::Config) => {
            let config = match load(Path::new(&arguments[1])) {
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

#[cfg(test)]
mod cli_tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn examples_parse_as_their_declared_action() {
        for invocation in INVOCATIONS {
            let words = args(invocation.example);
            assert_eq!(words[0], "stats");
            assert_eq!(parse(&words[1..]), Some(invocation.action), "{}", invocation.example);
            if invocation.action == Action::Bench {
                let (iterations, interval) = parse_bench(&words[1..]).unwrap();
                assert!((1..=1000).contains(&iterations));
                assert!((100..=3_600_000).contains(&interval));
            }
        }
    }

    #[test]
    fn parsing_preserves_existing_forms_and_rejects_wrong_arity() {
        assert_eq!(parse(&args("--config config.json")), Some(Action::Config));
        assert_eq!(parse(&args("--once")), Some(Action::Once));
        assert_eq!(parse(&args("--bench 2 100")), Some(Action::Bench));
        assert_eq!(parse(&args("--version")), Some(Action::Version));
        assert_eq!(parse(&args("-h")), Some(Action::Help));
        assert_eq!(parse(&[]), Some(Action::Help));
        for invalid in ["--config", "--once extra", "--bench 2", "--bench 2 100 extra", "--version extra", "--unknown"] {
            assert_eq!(parse(&args(invalid)), None, "{invalid}");
        }
        let mut flags = std::collections::HashSet::new();
        for invocation in INVOCATIONS {
            for flag in invocation.flag.split(", ") {
                assert!(flags.insert(flag), "duplicate flag: {flag}");
            }
        }
    }
}
