use crate::block_fold::{fold, STATS_SLOTS};
use crate::model::Block;
use aya::Ebpf;
use aya::maps::{MapData, PerCpuArray, PerCpuValues};
use aya::programs::TracePoint;

static PROBE: &[u8] = include_bytes!(env!("STATS_BLOCK_PROBE"));

pub struct Probe {
    ebpf: Ebpf,
}

impl Probe {
    pub fn load() -> Option<Self> {
        match Self::attach() {
            Ok(probe) => Some(probe),
            Err(error) => {
                eprintln!("stats: block latency probe unavailable ({error}); the sample omits the block group");
                None
            }
        }
    }

    fn attach() -> Result<Self, String> {
        let mut ebpf = Ebpf::load(PROBE).map_err(|error| error.to_string())?;
        for (program_name, tracepoint) in [("rq_issue", "block_rq_issue"), ("rq_complete", "block_rq_complete")] {
            let program: &mut TracePoint = ebpf.program_mut(program_name).ok_or_else(|| format!("probe has no program {program_name}"))?.try_into().map_err(|error: aya::programs::ProgramError| error.to_string())?;
            program.load().map_err(|error| error.to_string())?;
            program.attach("block", tracepoint).map_err(|error| error.to_string())?;
        }
        Ok(Probe { ebpf })
    }

    pub fn poll(&mut self) -> Option<Block> {
        let nr_cpus = aya::util::nr_cpus().ok().map(|count| count.get() as usize)?;
        let mut views = Vec::with_capacity(STATS_SLOTS);
        {
            let array = PerCpuArray::<&MapData, u64>::try_from(&*self.ebpf.map_mut("stats")?).ok()?;
            for slot in 0..STATS_SLOTS {
                let values = array.get(&(slot as u32), 0).ok()?;
                if values.len() != nr_cpus {
                    return None;
                }
                views.push(values.iter().copied().collect::<Vec<_>>());
            }
        }
        let mut per_cpu = vec![[0_u64; STATS_SLOTS]; nr_cpus];
        for (slot, cpu_values) in views.iter().enumerate() {
            for (cpu, value) in cpu_values.iter().enumerate() {
                per_cpu[cpu][slot] = *value;
            }
        }
        {
            let mut array = PerCpuArray::<&mut MapData, u64>::try_from(&mut *self.ebpf.map_mut("stats")?).ok()?;
            for slot in 0..STATS_SLOTS {
                let zeros = vec![0_u64; nr_cpus];
                array.set(slot as u32, PerCpuValues::try_from(zeros).ok()?, 0).ok()?;
            }
        }
        Some(fold(&per_cpu))
    }
}
