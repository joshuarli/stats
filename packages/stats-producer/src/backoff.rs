use std::time::Duration;

pub fn backoff_delay(attempt: u32, base: Duration, jitter: f64, ceiling: Duration) -> Duration {
    let factor = 2_f64.powi(attempt.min(20) as i32);
    let millis = base.as_millis() as f64 * factor * (0.5 + jitter.clamp(0.0, 1.0) * 0.5);
    Duration::from_millis((millis.round() as u64).min(ceiling.as_millis() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_stays_inside_the_jitter_band() {
        let base = Duration::from_millis(100);
        let ceiling = Duration::from_secs(30);
        assert_eq!(backoff_delay(0, base, 0.0, ceiling), Duration::from_millis(50));
        assert_eq!(backoff_delay(0, base, 1.0, ceiling), Duration::from_millis(100));
        assert_eq!(backoff_delay(1, base, 0.0, ceiling), Duration::from_millis(100));
        assert_eq!(backoff_delay(2, base, 1.0, ceiling), Duration::from_millis(400));
        assert_eq!(backoff_delay(30, base, 1.0, ceiling), ceiling);
    }
}
