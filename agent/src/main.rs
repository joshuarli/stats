use niceforge_telemetry::{sample_once, VERSION};

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.as_slice() {
        [flag] if flag == "--version" => println!("niceforge-telemetry {VERSION}"),
        [flag] if flag == "--once" => match sample_once() {
            Some(sample) => match serde_json::to_string_pretty(&sample) {
                Ok(text) => println!("{text}"),
                Err(error) => {
                    eprintln!("could not encode sample: {error}");
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("no usable host sample on this platform");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("usage: niceforge-telemetry --once | --version");
            std::process::exit(2);
        }
    }
}
