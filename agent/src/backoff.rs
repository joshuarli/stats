use std::time::Duration;

pub struct Backoff {
    base_ms: u64,
    max_ms: u64,
    next_ms: u64,
    seed: u64,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration, seed: u64) -> Self {
        let base_ms = base.as_millis().max(1) as u64;
        let max_ms = max.as_millis().max(base_ms as u128) as u64;
        Self {
            base_ms,
            max_ms,
            next_ms: base_ms,
            seed: seed | 1,
        }
    }

    fn jitter(&mut self) -> u64 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        let ceiling = (self.base_ms / 5).max(1);
        self.seed % ceiling
    }

    pub fn delay(&mut self, retry_after: Option<Duration>) -> Duration {
        let base = self.next_ms.min(self.max_ms);
        self.next_ms = self.next_ms.saturating_mul(2).min(self.max_ms);
        if let Some(retry_after) = retry_after {
            return Duration::from_millis(retry_after.as_millis().clamp(self.base_ms as u128, self.max_ms as u128) as u64);
        }
        Duration::from_millis((base + self.jitter()).min(self.max_ms))
    }

    pub fn reset(&mut self) {
        self.next_ms = self.base_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_to_the_cap_and_resets() {
        let mut backoff = Backoff::new(Duration::from_millis(1000), Duration::from_millis(4000), 7);
        let first = backoff.delay(None);
        let second = backoff.delay(None);
        let third = backoff.delay(None);
        let fourth = backoff.delay(None);
        assert!((1000..=1200).contains(&first.as_millis()));
        assert!((2000..=2200).contains(&second.as_millis()));
        assert!((4000..=4000).contains(&third.as_millis()));
        assert_eq!(fourth, Duration::from_millis(4000));
        backoff.reset();
        assert!((1000..=1200).contains(&backoff.delay(None).as_millis()));
    }

    #[test]
    fn retry_after_is_bounded() {
        let mut backoff = Backoff::new(Duration::from_millis(1000), Duration::from_secs(60), 11);
        assert_eq!(backoff.delay(Some(Duration::from_secs(2))), Duration::from_secs(2));
        assert_eq!(backoff.delay(Some(Duration::from_secs(600))), Duration::from_secs(60));
    }

    #[test]
    fn retry_after_never_drops_below_the_base_delay() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60), 11);
        assert_eq!(backoff.delay(Some(Duration::ZERO)), Duration::from_secs(1));
        assert_eq!(backoff.delay(Some(Duration::from_millis(10))), Duration::from_secs(1));
    }
}
