use crate::model::{BatteryPower, Power};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

fn text(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.take(65).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 64 { return None; }
    Some(std::str::from_utf8(&bytes).ok()?.trim().to_owned())
}

fn counter(path: &Path) -> Option<u64> {
    let value = text(path)?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    value.parse().ok()
}

fn packages(root: &Path) -> Option<Vec<(String, u64, u64)>> {
    let mut readings = Vec::new();
    let mut packages = std::collections::HashSet::new();
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        if name.bytes().filter(|byte| *byte == b':').count() != 1 { continue; }
        let path = entry.path();
        let package = text(&path.join("name"))?;
        if !package.starts_with("package-") { continue; }
        if !packages.insert(package) { return None; }
        let energy = counter(&path.join("energy_uj"))?;
        let range = counter(&path.join("max_energy_range_uj"))?;
        if range == 0 || energy >= range { return None; }
        readings.push((name, energy, range));
    }
    readings.sort_by(|left, right| left.0.cmp(&right.0));
    (!readings.is_empty()).then_some(readings)
}

fn batteries(root: &Path) -> Option<(Vec<String>, u64)> {
    let mut names = Vec::new();
    let mut milliwatts = 0_u64;
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if text(&path.join("type"))? != "Battery" { continue; }
        if text(&path.join("status"))? != "Discharging" { continue; }
        let power = if path.join("power_now").exists() {
            counter(&path.join("power_now"))?.checked_div(1000)?
        } else {
            counter(&path.join("current_now"))?.checked_mul(counter(&path.join("voltage_now"))?)?.checked_div(1_000_000_000)?
        };
        milliwatts = milliwatts.checked_add(power)?;
        names.push(entry.file_name().into_string().ok()?);
    }
    names.sort();
    (!names.is_empty()).then_some((names, milliwatts))
}

#[derive(Default)]
pub(crate) struct PowerSampler {
    packages: Option<Vec<(String, u64, u64)>>,
    cpu_nj: u64,
    batteries: Option<Vec<String>>,
    battery: Option<BatteryPower>,
}

impl PowerSampler {
    pub(crate) fn sample(&mut self, powercap: &Path, supply: &Path) -> Option<Power> {
        let cpu_nj = self.cpu(packages(powercap));
        let battery = self.battery(batteries(supply));
        (cpu_nj.is_some() || battery.is_some()).then_some(Power { cpu_nj, battery, gpu_nj: None, system: None })
    }

    fn cpu(&mut self, current: Option<Vec<(String, u64, u64)>>) -> Option<u64> {
        let previous = std::mem::replace(&mut self.packages, current);
        let Some(current) = &self.packages else { self.cpu_nj = 0; return None; };
        let Some(previous) = previous else { self.cpu_nj = 0; return Some(0); };
        let delta = (|| {
            if current.len() != previous.len() { return None; }
            let mut delta = 0_u64;
            for ((name, energy, range), (before_name, before_energy, before_range)) in current.iter().zip(&previous) {
                if name != before_name || range != before_range { return None; }
                delta = delta.checked_add(energy.checked_sub(*before_energy)?)?;
            }
            self.cpu_nj.checked_add(delta.checked_mul(1000)?)
        })();
        self.cpu_nj = delta.unwrap_or(0);
        delta
    }

    fn battery(&mut self, current: Option<(Vec<String>, u64)>) -> Option<BatteryPower> {
        let Some((names, power)) = current else { self.batteries = None; self.battery = None; return None; };
        if self.batteries.as_ref() != Some(&names) {
            self.batteries = Some(names);
            self.battery = Some(BatteryPower { milliwatt_sum: power, readings: 1 });
            return None;
        }
        let previous = self.battery.take()?;
        self.battery = previous.milliwatt_sum.checked_add(power).zip(previous.readings.checked_add(1)).map(|(milliwatt_sum, readings)| BatteryPower { milliwatt_sum, readings });
        if self.battery.is_none() { self.batteries = None; }
        self.battery.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch;

    fn write(root: &Path, name: &str, fields: &[(&str, &str)]) {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        for (field, value) in fields { fs::write(path.join(field), value).unwrap(); }
    }

    #[test]
    fn package_counters_exclude_children_and_gap_on_wrap_reset_and_source_changes() {
        let root = scratch("power-packages");
        let supply = root.join("missing");
        let package = |name: &str, energy: &str| write(&root, name, &[("name", if name.ends_with(":1") { "package-1" } else { "package-0" }), ("energy_uj", energy), ("max_energy_range_uj", "1000000")]);
        package("intel-rapl:0", "999900");
        write(&root, "intel-rapl:0:0", &[("name", "core"), ("energy_uj", "999999")]);
        let mut sampler = PowerSampler::default();
        assert_eq!(sampler.sample(&root, &supply).unwrap().cpu_nj, Some(0));
        package("intel-rapl:0", "999950");
        assert_eq!(sampler.sample(&root, &supply).unwrap().cpu_nj, Some(50000));
        package("intel-rapl:0", "10");
        assert_eq!(sampler.sample(&root, &supply), None);
        package("intel-rapl:0", "20");
        assert_eq!(sampler.sample(&root, &supply).unwrap().cpu_nj, Some(10000));
        package("intel-rapl:1", "200");
        assert_eq!(sampler.sample(&root, &supply), None);
        package("intel-rapl:0", "30");
        package("intel-rapl:1", "210");
        assert_eq!(sampler.sample(&root, &supply).unwrap().cpu_nj, Some(20000));
        fs::remove_file(root.join("intel-rapl:1/energy_uj")).unwrap();
        assert_eq!(sampler.sample(&root, &supply), None);
        package("intel-rapl:1", "220");
        assert_eq!(sampler.sample(&root, &supply).unwrap().cpu_nj, Some(0));
        package("intel-rapl-mmio:0", "50");
        assert_eq!(sampler.sample(&root, &supply), None);
    }

    #[test]
    fn batteries_measure_only_discharge_and_omit_incomplete_or_overflowing_sources() {
        let root = scratch("power-batteries");
        let powercap = root.join("missing");
        write(&root, "AC", &[("type", "Mains")]);
        write(&root, "BAT0", &[("type", "Battery"), ("status", "Charging"), ("power_now", "30000000")]);
        let mut sampler = PowerSampler::default();
        assert_eq!(sampler.sample(&powercap, &root), None);
        fs::write(root.join("BAT0/status"), "Discharging").unwrap();
        assert_eq!(sampler.sample(&powercap, &root), None);
        let battery = sampler.sample(&powercap, &root).unwrap().battery.unwrap();
        assert_eq!(battery, BatteryPower { milliwatt_sum: 60000, readings: 2 });
        fs::remove_file(root.join("BAT0/power_now")).unwrap();
        write(&root, "BAT0", &[("current_now", "2000000"), ("voltage_now", "12000000")]);
        assert_eq!(sampler.sample(&powercap, &root).unwrap().battery.unwrap().milliwatt_sum, 84000);
        fs::write(root.join("BAT0/current_now"), "18446744073709551615").unwrap();
        assert_eq!(sampler.sample(&powercap, &root), None);
        fs::write(root.join("BAT0/status"), "Full").unwrap();
        assert_eq!(sampler.sample(&powercap, &root), None);
    }
}
