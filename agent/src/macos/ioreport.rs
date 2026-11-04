use super::cf::{dictionary_value, has_type, kCFTypeArrayCallBacks, string, CFArrayAppendValue, CFArrayCreateMutable, CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFDictionaryCreateMutableCopy, CFDictionarySetValue, CfRef, Owned};
use crate::model::Gpu;
use std::ffi::{c_void, CStr};
use std::sync::{Mutex, OnceLock};

const LIBRARY: &CStr = c"/usr/lib/libIOReport.dylib";
const ENERGY_GROUP: &str = "Energy Model";
const GPU_ENERGY_CHANNEL: &str = "GPU Energy";
const GPU_STATS_GROUP: &str = "GPU Stats";
const GPU_STATES_SUBGROUP: &str = "GPU Performance States";
const GPU_STATES_CHANNEL: &str = "GPUPH";
const GPU_IDLE_STATE: &str = "OFF";

type CopyChannelsInGroup = unsafe extern "C" fn(CfRef, CfRef, u64, u64, u64) -> CfRef;
type MergeChannels = unsafe extern "C" fn(CfRef, CfRef, CfRef);
type CreateSubscription = unsafe extern "C" fn(CfRef, CfRef, *mut CfRef, u64, CfRef) -> CfRef;
type CreateSamples = unsafe extern "C" fn(CfRef, CfRef, CfRef) -> CfRef;
type ChannelString = unsafe extern "C" fn(CfRef) -> CfRef;
type IntegerValue = unsafe extern "C" fn(CfRef, i32) -> i64;
type StateCount = unsafe extern "C" fn(CfRef) -> i32;
type StateName = unsafe extern "C" fn(CfRef, i32) -> CfRef;
type StateResidency = unsafe extern "C" fn(CfRef, i32) -> i64;

struct Api {
    create_samples: CreateSamples,
    channel_group: ChannelString,
    channel_name: ChannelString,
    channel_unit: ChannelString,
    integer_value: IntegerValue,
    state_count: StateCount,
    state_name: StateName,
    state_residency: StateResidency,
}

struct Subscription {
    api: Api,
    subscription: CfRef,
    channels: CfRef,
}

unsafe impl Send for Subscription {}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GpuReading {
    pub gpu: Option<Gpu>,
    pub energy_nj: Option<u64>,
}

fn symbol<T: Copy>(handle: *mut c_void, name: &CStr) -> Option<T> {
    let pointer = unsafe { libc::dlsym(handle, name.as_ptr()) };
    (!pointer.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, T>(&pointer) })
}

fn group_channels(copy: CopyChannelsInGroup, group: &str, subgroup: Option<&str>) -> Option<Owned> {
    let group = Owned::string(group)?;
    let subgroup = match subgroup {
        Some(name) => Some(Owned::string(name)?),
        None => None,
    };
    Owned::new(unsafe { copy(group.0, subgroup.as_ref().map_or(std::ptr::null(), |name| name.0), 0, 0, 0) })
}

fn channel_array(dictionary: CfRef) -> Option<CfRef> {
    let channels = dictionary_value(dictionary, "IOReportChannels")?;
    has_type(channels, unsafe { CFArrayGetTypeID() }).then_some(channels)
}

fn only_channel(channel_name: ChannelString, group: &Owned, name: &str) -> Option<Owned> {
    let source = channel_array(group.0)?;
    let kept = Owned::new(unsafe { CFArrayCreateMutable(std::ptr::null(), 0, &raw const kCFTypeArrayCallBacks) })?;
    for index in 0..unsafe { CFArrayGetCount(source) } {
        let channel = unsafe { CFArrayGetValueAtIndex(source, index) };
        if string(unsafe { channel_name(channel) }).as_deref() == Some(name) {
            unsafe { CFArrayAppendValue(kept.0, channel) };
        }
    }
    let narrowed = Owned::new(unsafe { CFDictionaryCreateMutableCopy(std::ptr::null(), 0, group.0) })?;
    let key = Owned::string("IOReportChannels")?;
    unsafe { CFDictionarySetValue(narrowed.0, key.0, kept.0) };
    Some(narrowed)
}

fn open() -> Option<Subscription> {
    let handle = unsafe { libc::dlopen(LIBRARY.as_ptr(), libc::RTLD_LAZY) };
    if handle.is_null() {
        return None;
    }
    let copy: CopyChannelsInGroup = symbol(handle, c"IOReportCopyChannelsInGroup")?;
    let merge: MergeChannels = symbol(handle, c"IOReportMergeChannels")?;
    let subscribe: CreateSubscription = symbol(handle, c"IOReportCreateSubscription")?;
    let api = Api {
        create_samples: symbol(handle, c"IOReportCreateSamples")?,
        channel_group: symbol(handle, c"IOReportChannelGetGroup")?,
        channel_name: symbol(handle, c"IOReportChannelGetChannelName")?,
        channel_unit: symbol(handle, c"IOReportChannelGetUnitLabel")?,
        integer_value: symbol(handle, c"IOReportSimpleGetIntegerValue")?,
        state_count: symbol(handle, c"IOReportStateGetCount")?,
        state_name: symbol(handle, c"IOReportStateGetNameForIndex")?,
        state_residency: symbol(handle, c"IOReportStateGetResidency")?,
    };
    let energy = only_channel(api.channel_name, &group_channels(copy, ENERGY_GROUP, None)?, GPU_ENERGY_CHANNEL)?;
    let gpu_states = only_channel(api.channel_name, &group_channels(copy, GPU_STATS_GROUP, Some(GPU_STATES_SUBGROUP))?, GPU_STATES_CHANNEL)?;
    let channels = unsafe { CFDictionaryCreateMutableCopy(std::ptr::null(), 0, energy.0) };
    if channels.is_null() {
        return None;
    }
    unsafe { merge(channels, gpu_states.0, std::ptr::null()) };
    let mut subscribed: CfRef = std::ptr::null();
    let subscription = unsafe { subscribe(std::ptr::null(), channels, &mut subscribed, 0, std::ptr::null()) };
    if subscription.is_null() {
        drop(Owned(channels));
        return None;
    }
    Some(Subscription { api, subscription, channels })
}

fn subscription() -> Option<&'static Mutex<Subscription>> {
    static SUBSCRIPTION: OnceLock<Option<Mutex<Subscription>>> = OnceLock::new();
    SUBSCRIPTION.get_or_init(|| open().map(Mutex::new)).as_ref()
}

fn gpu_from_states(states: &[(String, u64)]) -> Option<Gpu> {
    let idle = states.iter().find(|(name, _)| name == GPU_IDLE_STATE)?.1;
    let total = states.iter().try_fold(0u64, |sum, (_, residency)| sum.checked_add(*residency))?;
    let active = total.checked_sub(idle)?;
    Some(Gpu { active, total })
}

fn energy_nanojoules(value: i64, unit: &str) -> Option<u64> {
    let factor = match unit.trim() {
        "nJ" => 1,
        "uJ" | "µJ" => 1_000,
        "mJ" => 1_000_000,
        _ => return None,
    };
    u64::try_from(value).ok()?.checked_mul(factor)
}

impl Subscription {
    fn read(&self) -> Option<GpuReading> {
        let api = &self.api;
        let sample = Owned::new(unsafe { (api.create_samples)(self.subscription, self.channels, std::ptr::null()) })?;
        let channels = channel_array(sample.0)?;
        let mut reading = GpuReading::default();
        for index in 0..unsafe { CFArrayGetCount(channels) } {
            let channel = unsafe { CFArrayGetValueAtIndex(channels, index) };
            let text = |read: ChannelString| string(unsafe { read(channel) });
            let (Some(group), Some(name)) = (text(api.channel_group), text(api.channel_name)) else { continue };
            if group == ENERGY_GROUP && name == GPU_ENERGY_CHANNEL {
                let unit = text(api.channel_unit)?;
                reading.energy_nj = energy_nanojoules(unsafe { (api.integer_value)(channel, 0) }, &unit);
            } else if group == GPU_STATS_GROUP && name == GPU_STATES_CHANNEL {
                let states: Option<Vec<(String, u64)>> = (0..unsafe { (api.state_count)(channel) })
                    .map(|state| Some((string(unsafe { (api.state_name)(channel, state) })?, u64::try_from(unsafe { (api.state_residency)(channel, state) }).ok()?)))
                    .collect();
                reading.gpu = states.as_deref().and_then(gpu_from_states);
            }
        }
        Some(reading)
    }
}

pub fn read_gpu() -> GpuReading {
    subscription().and_then(|subscription| subscription.lock().ok()?.read()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(pairs: &[(&str, u64)]) -> Vec<(String, u64)> {
        pairs.iter().map(|(name, residency)| ((*name).to_owned(), *residency)).collect()
    }

    #[test]
    fn gpu_activity_is_every_state_but_off() {
        let gpu = gpu_from_states(&states(&[("OFF", 283), ("P1", 76), ("P2", 1)])).unwrap();
        assert_eq!((gpu.active, gpu.total), (77, 360));
    }

    #[test]
    fn gpu_activity_is_unknown_without_an_off_state() {
        assert_eq!(gpu_from_states(&states(&[("P1", 76), ("P2", 1)])), None);
    }

    #[test]
    fn energy_is_normalized_to_nanojoules_and_unknown_units_are_refused() {
        assert_eq!(energy_nanojoules(5, "nJ"), Some(5));
        assert_eq!(energy_nanojoules(5, " mJ "), Some(5_000_000));
        assert_eq!(energy_nanojoules(5, "uJ"), Some(5_000));
        assert_eq!(energy_nanojoules(5, "W"), None);
        assert_eq!(energy_nanojoules(-1, "nJ"), None);
    }
}
