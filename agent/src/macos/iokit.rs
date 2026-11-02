use crate::model::{Disk, SystemPower};
use super::cf::{dictionary_value, number, string, CfRef, Owned};
use std::ffi::{c_char, c_void, CStr};

type IoObject = libc::mach_port_t;

const MAIN_PORT_DEFAULT: libc::mach_port_t = 0;
const SERVICE_PLANE: &CStr = c"IOService";
const VIRTUAL_INTERCONNECT: &str = "Virtual Interface";
const SECTOR_BYTES: u64 = 512;
const MAX_MAJOR: u64 = 4095;
const MAX_MINOR: u64 = 1_048_575;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOServiceMatching(name: *const c_char) -> *mut c_void;
    fn IOServiceGetMatchingServices(main_port: libc::mach_port_t, matching: CfRef, existing: *mut IoObject) -> libc::kern_return_t;
    fn IOIteratorNext(iterator: IoObject) -> IoObject;
    fn IOObjectRelease(object: IoObject) -> libc::kern_return_t;
    fn IOObjectConformsTo(object: IoObject, class_name: *const c_char) -> libc::boolean_t;
    fn IORegistryEntryGetParentEntry(entry: IoObject, plane: *const c_char, parent: *mut IoObject) -> libc::kern_return_t;
    fn IORegistryEntryGetChildEntry(entry: IoObject, plane: *const c_char, child: *mut IoObject) -> libc::kern_return_t;
    fn IORegistryEntryCreateCFProperty(entry: IoObject, key: CfRef, allocator: CfRef, options: u32) -> CfRef;
    fn IOServiceGetMatchingService(main_port: libc::mach_port_t, matching: CfRef) -> IoObject;
}


struct Entry(IoObject);

impl Entry {
    fn new(object: IoObject) -> Option<Self> {
        (object != 0).then_some(Self(object))
    }

    fn related(&self, relate: unsafe extern "C" fn(IoObject, *const c_char, *mut IoObject) -> libc::kern_return_t) -> Option<Self> {
        let mut other: IoObject = 0;
        let status = unsafe { relate(self.0, SERVICE_PLANE.as_ptr(), &mut other) };
        if status == libc::KERN_SUCCESS { Self::new(other) } else { None }
    }

    fn conforms_to(&self, class: &CStr) -> bool {
        unsafe { IOObjectConformsTo(self.0, class.as_ptr()) != 0 }
    }

    fn property(&self, key: &str) -> Option<Owned> {
        let key = Owned::string(key)?;
        Owned::new(unsafe { IORegistryEntryCreateCFProperty(self.0, key.0, std::ptr::null(), 0) })
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        unsafe { IOObjectRelease(self.0) };
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counters {
    reads: u64,
    read_bytes: u64,
    writes: u64,
    write_bytes: u64,
}

fn valid_disk_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn disk_from(name: String, major: u64, minor: u64, counters: Counters) -> Option<Disk> {
    if major > MAX_MAJOR || minor > MAX_MINOR || !valid_disk_name(&name) {
        return None;
    }
    Some(Disk {
        id: format!("{major}:{minor}"),
        name,
        reads: counters.reads.to_string(),
        read_sectors: (counters.read_bytes / SECTOR_BYTES).to_string(),
        writes: counters.writes.to_string(),
        write_sectors: (counters.write_bytes / SECTOR_BYTES).to_string(),
        io_ms: None,
    })
}

fn physical(interconnect: Option<&str>) -> bool {
    interconnect != Some(VIRTUAL_INTERCONNECT)
}

fn driver_disk(driver: &Entry) -> Option<Disk> {
    let device = driver.related(IORegistryEntryGetParentEntry)?;
    let characteristics = device.property("Protocol Characteristics");
    let interconnect = characteristics.as_ref().and_then(|value| dictionary_value(value.0, "Physical Interconnect")).and_then(string);
    if !physical(interconnect.as_deref()) {
        return None;
    }
    let media = driver.related(IORegistryEntryGetChildEntry)?;
    if !media.conforms_to(c"IOMedia") {
        return None;
    }
    let name = string(media.property("BSD Name")?.0)?;
    let major = number(media.property("BSD Major")?.0)?;
    let minor = number(media.property("BSD Minor")?.0)?;
    let statistics = driver.property("Statistics")?;
    let field = |key: &str| dictionary_value(statistics.0, key).and_then(number);
    let counters = Counters {
        reads: field("Operations (Read)")?,
        read_bytes: field("Bytes (Read)")?,
        writes: field("Operations (Write)")?,
        write_bytes: field("Bytes (Write)")?,
    };
    disk_from(name, major, minor, counters)
}

pub fn read_system_power() -> Option<SystemPower> {
    let matching = unsafe { IOServiceMatching(c"AppleSmartBattery".as_ptr()) };
    if matching.is_null() {
        return None;
    }
    let battery = Entry::new(unsafe { IOServiceGetMatchingService(MAIN_PORT_DEFAULT, matching) })?;
    let telemetry = battery.property("PowerTelemetryData")?;
    let milliwatt_sum = dictionary_value(telemetry.0, "AccumulatedSystemLoad").and_then(number)?;
    let readings = dictionary_value(telemetry.0, "SystemLoadAccumulatorCount").and_then(number)?;
    Some(SystemPower { milliwatt_sum: milliwatt_sum.to_string(), readings: readings.to_string() })
}

pub fn read_disks(limit: usize) -> Option<Vec<Disk>> {
    let matching = unsafe { IOServiceMatching(c"IOBlockStorageDriver".as_ptr()) };
    if matching.is_null() {
        return None;
    }
    let mut iterator: IoObject = 0;
    if unsafe { IOServiceGetMatchingServices(MAIN_PORT_DEFAULT, matching, &mut iterator) } != libc::KERN_SUCCESS {
        return None;
    }
    let iterator = Entry::new(iterator)?;
    let mut disks = Vec::new();
    while let Some(driver) = Entry::new(unsafe { IOIteratorNext(iterator.0) }) {
        if let Some(disk) = driver_disk(&driver) {
            disks.push(disk);
        }
    }
    disks.sort_by(|left, right| left.name.cmp(&right.name));
    disks.truncate(limit);
    Some(disks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const COUNTERS: Counters = Counters { reads: 10, read_bytes: 4096, writes: 3, write_bytes: 1000 };

    #[test]
    fn bytes_become_whole_sectors_and_busy_time_stays_absent() {
        let disk = disk_from("disk0".into(), 1, 0, COUNTERS).unwrap();
        assert_eq!((disk.id.as_str(), disk.read_sectors.as_str(), disk.write_sectors.as_str()), ("1:0", "8", "1"));
        assert_eq!(disk.io_ms, None);
    }

    #[test]
    fn device_numbers_outside_the_wire_bounds_are_dropped() {
        assert!(disk_from("disk0".into(), 4096, 0, COUNTERS).is_none());
        assert!(disk_from("disk0".into(), 1, 1_048_576, COUNTERS).is_none());
    }

    #[test]
    fn disk_images_are_not_physical_but_unlabelled_devices_are() {
        assert!(!physical(Some("Virtual Interface")));
        assert!(physical(Some("Apple Fabric")));
        assert!(physical(None));
    }
}
