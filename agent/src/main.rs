use niceforge_telemetry::config::{load, load_token};
use niceforge_telemetry::runtime::{install_signal_handlers, run};
use niceforge_telemetry::{sample_once, VERSION};
use std::path::Path;

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
            println!("niceforge-telemetry {VERSION}");
            0
        }
        [flag] if flag == "--once" => once(),
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
                        "telemetry stopped: sampled={} sample_failures={} accepted={} duplicates={} rejected={} dropped={} upload_failures={}",
                        report.sampled, report.sample_failures, report.accepted, report.duplicates, report.rejected, report.dropped, report.upload_failures
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
            eprintln!("usage: niceforge-telemetry --config <path> | --once | --version");
            2
        }
    };
    std::process::exit(status);
}
