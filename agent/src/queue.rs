use crate::model::Sample;
use std::collections::VecDeque;

pub struct Queue {
    max: usize,
    samples: VecDeque<Sample>,
    dropped: u64,
}

impl Queue {
    pub fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            samples: VecDeque::new(),
            dropped: 0,
        }
    }

    pub fn push(&mut self, sample: Sample) {
        if self.samples.len() == self.max {
            self.samples.pop_front();
            self.dropped += 1;
        }
        self.samples.push_back(sample);
    }

    pub fn take_batch(&mut self, limit: usize) -> Vec<Sample> {
        let count = self.samples.len().min(limit.max(1));
        self.samples.drain(..count).collect()
    }

    pub fn requeue_front(&mut self, batch: Vec<Sample>) {
        for sample in batch.into_iter().rev() {
            self.samples.push_front(sample);
        }
        while self.samples.len() > self.max {
            self.samples.pop_back();
            self.dropped += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(seq: u64) -> Sample {
        Sample::empty(seq, seq, seq)
    }

    #[test]
    fn saturation_drops_the_oldest_sample() {
        let mut queue = Queue::new(2);
        queue.push(sample(1));
        queue.push(sample(2));
        queue.push(sample(3));
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.dropped(), 1);
        let batch = queue.take_batch(10);
        assert_eq!(batch.iter().map(|sample| sample.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn requeue_preserves_order_and_the_bound() {
        let mut queue = Queue::new(3);
        queue.push(sample(1));
        queue.push(sample(2));
        let batch = queue.take_batch(2);
        queue.push(sample(3));
        queue.push(sample(4));
        queue.requeue_front(batch);
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.dropped(), 1);
        let batch = queue.take_batch(10);
        assert_eq!(batch.iter().map(|sample| sample.seq).collect::<Vec<_>>(), [1, 2, 3]);
    }

    #[test]
    fn empty_batches_are_empty() {
        let mut queue = Queue::new(4);
        assert!(queue.take_batch(2).is_empty());
        assert!(queue.is_empty());
    }
}
