use crate::model::{Block, BLOCK_BUCKETS};

pub const STATS_SLOTS: usize = 20;
const COUNT: usize = 16;
const TOTAL_US: usize = 17;
const MIN_US: usize = 18;
const MAX_US: usize = 19;

pub fn fold(per_cpu: &[[u64; STATS_SLOTS]]) -> Block {
    let mut buckets = [0_u64; BLOCK_BUCKETS];
    let mut count = 0_u64;
    let mut total_us = 0_u64;
    let mut min_us = u64::MAX;
    let mut max_us = 0_u64;
    for slots in per_cpu {
        for (acc, slot) in buckets.iter_mut().zip(&slots[..BLOCK_BUCKETS]) {
            *acc += slot;
        }
        count += slots[COUNT];
        total_us += slots[TOTAL_US];
        if slots[MIN_US] != 0 {
            min_us = min_us.min(slots[MIN_US]);
        }
        max_us = max_us.max(slots[MAX_US]);
    }
    let min_us = if min_us == u64::MAX { 0 } else { min_us };
    Block { buckets, count, total_us, min_us, max_us }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots(count: u64, total_us: u64, min_us: u64, max_us: u64) -> [u64; STATS_SLOTS] {
        let mut value = [0_u64; STATS_SLOTS];
        value[COUNT] = count;
        value[TOTAL_US] = total_us;
        value[MIN_US] = min_us;
        value[MAX_US] = max_us;
        value
    }

    #[test]
    fn folds_an_empty_window_into_zeros() {
        let block = fold(&[]);
        assert_eq!(block.count, 0);
        assert_eq!(block.total_us, 0);
        assert_eq!((block.min_us, block.max_us), (0, 0));
        assert_eq!(block.buckets, [0; BLOCK_BUCKETS]);
    }

    #[test]
    fn folds_a_per_cpu_aggregate() {
        let mut slow = slots(3, 900, 250, 400);
        slow[0] = 2;
        slow[4] = 1;
        let mut fast = slots(2, 100, 10, 40);
        fast[3] = 2;
        let block = fold(&[slow, fast]);
        assert_eq!(block.count, 5);
        assert_eq!(block.total_us, 1000);
        assert_eq!(block.buckets[0], 2);
        assert_eq!(block.buckets[3], 2);
        assert_eq!(block.buckets[4], 1);
        assert_eq!((block.min_us, block.max_us), (10, 400));
    }

    #[test]
    fn treats_an_all_zero_min_slot_as_a_zero_latency_workload() {
        let block = fold(&[slots(1, 0, 0, 0)]);
        assert_eq!((block.count, block.min_us, block.max_us, block.total_us), (1, 0, 0, 0));
    }
}
