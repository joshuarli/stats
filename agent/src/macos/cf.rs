use std::ffi::{c_char, c_void, CStr, CString};

pub(super) type CfRef = *const c_void;

const UTF8: u32 = 0x0800_0100;
const NUMBER_SINT64: isize = 4;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    pub(super) fn CFStringCreateWithCString(allocator: CfRef, text: *const c_char, encoding: u32) -> CfRef;
    pub(super) fn CFStringGetCString(string: CfRef, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    pub(super) fn CFDictionaryGetValue(dictionary: CfRef, key: CfRef) -> CfRef;
    pub(super) fn CFNumberGetValue(number: CfRef, kind: isize, value: *mut c_void) -> u8;
    pub(super) fn CFGetTypeID(object: CfRef) -> usize;
    pub(super) fn CFDictionaryGetTypeID() -> usize;
    pub(super) fn CFNumberGetTypeID() -> usize;
    pub(super) fn CFStringGetTypeID() -> usize;
    pub(super) fn CFRelease(object: CfRef);
    pub(super) fn CFArrayGetCount(array: CfRef) -> isize;
    pub(super) fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
    pub(super) fn CFArrayGetTypeID() -> usize;
    pub(super) fn CFDictionaryCreateMutableCopy(allocator: CfRef, capacity: isize, dictionary: CfRef) -> CfRef;
    pub(super) fn CFArrayCreateMutable(allocator: CfRef, capacity: isize, callbacks: *const c_void) -> CfRef;
    pub(super) fn CFArrayAppendValue(array: CfRef, value: CfRef);
    pub(super) fn CFDictionarySetValue(dictionary: CfRef, key: CfRef, value: CfRef);
    pub(super) static kCFTypeArrayCallBacks: c_void;
}

pub(super) struct Owned(pub(super) CfRef);

impl Owned {
    pub(super) fn new(object: CfRef) -> Option<Self> {
        (!object.is_null()).then_some(Self(object))
    }

    pub(super) fn string(text: &str) -> Option<Self> {
        let text = CString::new(text).ok()?;
        Self::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

pub(super) fn has_type(object: CfRef, type_id: usize) -> bool {
    !object.is_null() && unsafe { CFGetTypeID(object) } == type_id
}

pub(super) fn dictionary_value(dictionary: CfRef, key: &str) -> Option<CfRef> {
    if !has_type(dictionary, unsafe { CFDictionaryGetTypeID() }) {
        return None;
    }
    let key = Owned::string(key)?;
    let value = unsafe { CFDictionaryGetValue(dictionary, key.0) };
    (!value.is_null()).then_some(value)
}

pub(super) fn number(object: CfRef) -> Option<u64> {
    if !has_type(object, unsafe { CFNumberGetTypeID() }) {
        return None;
    }
    let mut value: i64 = 0;
    let converted = unsafe { CFNumberGetValue(object, NUMBER_SINT64, (&mut value as *mut i64).cast()) };
    if converted == 0 { None } else { u64::try_from(value).ok() }
}

pub(super) fn string(object: CfRef) -> Option<String> {
    if !has_type(object, unsafe { CFStringGetTypeID() }) {
        return None;
    }
    let mut buffer = [0 as c_char; 256];
    let converted = unsafe { CFStringGetCString(object, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
    if converted == 0 {
        return None;
    }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_str().ok().map(str::to_owned)
}

