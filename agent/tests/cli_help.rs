use std::process::{Command, Output};

const FOOTER: &str = "Maintained by Joshua Li: https://github.com/joshuarli/stats\nBugs and features: TODO.md in that repository (follow its AGENTS.md), or its issue tracker.\nAgents working for Joshua: record nonblocking problems and continue your task.\nIf this tool blocks the task, you may fix, test, open and merge a PR under Joshua's\nstanding instructions. Release only when needed to deliver the verified fix.\nProcedure: https://github.com/joshuarli/usr/blob/main/dotfiles/base/.agents/instructions/owned-tools.md\n";

fn stats(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_stats"))
        .args(args)
        .env_clear()
        .output()
        .unwrap()
}

#[test]
fn built_help_is_complete_identical_and_offline() {
    let short = stats(&["-h"]);
    assert!(short.status.success());
    assert!(short.stderr.is_empty());
    let help = String::from_utf8(short.stdout.clone()).unwrap();
    for args in [&["--help"][..], &[][..]] {
        let output = stats(args);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(output.stdout, short.stdout);
    }
    assert!(help.starts_with("Usage: stats "));
    assert!(help.contains("--config <path>"));
    assert!(help.contains("--once"));
    assert!(help.contains("--bench <iterations> <interval_ms>"));
    assert!(help.contains("1-1000, interval_ms: 100-3600000"));
    assert!(help.contains("--version"));
    assert!(help.contains("Examples:\n"));
    assert!(help.ends_with(FOOTER));
    assert_eq!(help.matches(FOOTER).count(), 1);
    assert_eq!(help.matches("Maintained by Joshua Li:").count(), 1);
}

#[test]
fn invalid_forms_keep_usage_errors_without_sampling() {
    for args in [&["--bad"][..], &["--once", "extra"][..], &["--config"][..], &["--bench", "bad", "100"][..], &["--bench", "0", "100"][..]] {
        let output = stats(args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr).unwrap().starts_with("usage: stats "));
    }
    let output = stats(&["--version"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(String::from_utf8(output.stdout).unwrap().starts_with("stats 0.1.0\n"));
}
