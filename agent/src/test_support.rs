use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Scratch {
    path: PathBuf,
}

pub(crate) fn scratch(label: &str) -> Scratch {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.work/tmp/agent-tests").join(label);
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&path).unwrap();
    Scratch { path }
}

impl Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
