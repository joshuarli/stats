use crate::CollectionScope;
use serde::Deserialize;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_LIMIT: usize = 65_536;
const TOKEN_LIMIT: usize = 256;
const DEFAULT_SAMPLE_MS: u64 = 15_000;
const DEFAULT_UPLOAD_MS: u64 = 30_000;
const DEFAULT_QUEUE: usize = 16;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub endpoint: String,
    #[serde(rename = "hostId")]
    pub host_id: String,
    #[serde(rename = "tokenFile")]
    pub token_file: PathBuf,
    #[serde(rename = "sampleIntervalMs", default = "default_sample_ms")]
    pub sample_interval_ms: u64,
    #[serde(rename = "uploadIntervalMs", default = "default_upload_ms")]
    pub upload_interval_ms: u64,
    #[serde(rename = "maxQueueSamples", default = "default_queue")]
    pub max_queue_samples: usize,
    #[serde(rename = "requestTimeoutMs", default = "default_timeout_ms")]
    pub request_timeout_ms: u64,
    #[serde(rename = "blockLatencyFile", default)]
    pub block_latency_file: Option<PathBuf>,
    #[serde(rename = "includeVirtualInterfaces", default)]
    pub include_virtual_interfaces: bool,
    #[serde(rename = "includeVirtualFilesystems", default)]
    pub include_virtual_filesystems: bool,
}

impl AgentConfig {
    pub fn scope(&self) -> CollectionScope {
        CollectionScope {
            virtual_interfaces: self.include_virtual_interfaces,
            virtual_filesystems: self.include_virtual_filesystems,
        }
    }
}

fn default_sample_ms() -> u64 {
    DEFAULT_SAMPLE_MS
}
fn default_upload_ms() -> u64 {
    DEFAULT_UPLOAD_MS
}
fn default_queue() -> usize {
    DEFAULT_QUEUE
}
fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}

pub fn valid_host_id(value: &str) -> bool {
    value.len() == 34 && value.starts_with("h_") && value[2..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn valid_token(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("nft_") else { return false };
    rest.len() == 43 && rest.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_endpoint(value: &str) -> bool {
    if value.is_empty()
        || value.contains('@')
        || value.contains('?')
        || value.contains('#')
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return false;
    }
    value.starts_with("https://")
        || value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
        || value.starts_with("http://[::1]:")
}

fn owner_file(path: &Path, limit: usize) -> Result<Vec<u8>, ConfigError> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let file = match fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path) {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(ConfigError::new(format!("{}: symbolic links are not accepted", path.display())));
        }
        Err(error) => return Err(ConfigError::new(format!("{}: {error}", path.display()))),
    };
    let metadata = file.metadata().map_err(|error| ConfigError::new(format!("{}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(ConfigError::new(format!("{}: not a regular file", path.display())));
    }
    if metadata.len() > limit as u64 {
        return Err(ConfigError::new(format!("{}: exceeds {limit} bytes", path.display())));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(ConfigError::new(format!("{}: not owned by the running user", path.display())));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(ConfigError::new(format!("{}: mode {mode:o} is not owner-only", path.display())));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|error| ConfigError::new(format!("{}: {error}", path.display())))?;
    if bytes.len() > limit {
        return Err(ConfigError::new(format!("{}: exceeds {limit} bytes", path.display())));
    }
    Ok(bytes)
}

pub fn load(path: &Path) -> Result<AgentConfig, ConfigError> {
    let bytes = owner_file(path, CONFIG_LIMIT)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ConfigError::new(format!("{}: not UTF-8", path.display())))?;
    let mut config: AgentConfig = serde_json::from_str(text).map_err(|error| ConfigError::new(format!("{}: {error}", path.display())))?;
    if !valid_host_id(&config.host_id) {
        return Err(ConfigError::new("hostId must be h_ followed by 32 lowercase hex characters"));
    }
    config.endpoint = config.endpoint.trim_end_matches('/').to_owned();
    if !valid_endpoint(&config.endpoint) {
        return Err(ConfigError::new("endpoint must be https, or loopback http for local tests"));
    }
    if !(15_000..=3_600_000).contains(&config.sample_interval_ms) {
        return Err(ConfigError::new("sampleIntervalMs must be between 15000 and 3600000"));
    }
    if !(10_000..=3_600_000).contains(&config.upload_interval_ms) {
        return Err(ConfigError::new("uploadIntervalMs must be between 10000 and 3600000"));
    }
    if !(1..=256).contains(&config.max_queue_samples) {
        return Err(ConfigError::new("maxQueueSamples must be between 1 and 256"));
    }
    if !(100..=30_000).contains(&config.request_timeout_ms) {
        return Err(ConfigError::new("requestTimeoutMs must be between 100 and 30000"));
    }
    if config.token_file.as_os_str().is_empty() {
        return Err(ConfigError::new("tokenFile must not be empty"));
    }
    if !config.token_file.is_absolute() {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        config.token_file = parent.join(&config.token_file);
    }
    if let Some(block_latency_file) = &config.block_latency_file {
        if block_latency_file.as_os_str().is_empty() {
            return Err(ConfigError::new("blockLatencyFile must not be empty"));
        }
        if !block_latency_file.is_absolute() {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            config.block_latency_file = Some(parent.join(block_latency_file));
        }
    }
    Ok(config)
}

pub fn load_token_file(path: &Path) -> Result<String, ConfigError> {
    let bytes = owner_file(path, TOKEN_LIMIT)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ConfigError::new(format!("{}: not UTF-8", path.display())))?;
    let token = text.trim();
    if !valid_token(token) {
        return Err(ConfigError::new(format!("{}: token must be nft_ followed by 43 base64url characters", path.display())));
    }
    Ok(token.to_owned())
}

pub fn load_token(config: &AgentConfig) -> Result<String, ConfigError> {
    load_token_file(&config.token_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn scratch() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/config-tests");
        fs::create_dir_all(&root).unwrap();
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("{}-{nanos}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, text: &str, mode: u32) {
        fs::write(path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
    }

    fn valid_config(token: &Path) -> String {
        format!(r#"{{"endpoint":"https://telemetry.example.com","hostId":"h_0123456789abcdef0123456789abcdef","tokenFile":"{}","sampleIntervalMs":15000,"uploadIntervalMs":30000,"maxQueueSamples":16,"requestTimeoutMs":10000}}"#, token.display())
    }

    #[test]
    fn loads_owner_only_config_and_defaults() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        write(&path, &valid_config(&token), 0o600);
        let config = load(&path).unwrap();
        assert_eq!(config.host_id, "h_0123456789abcdef0123456789abcdef");
        assert_eq!(config.sample_interval_ms, 15_000);
        assert!(load_token(&config).unwrap().starts_with("nft_"));
    }

    #[test]
    fn defaults_apply_when_optional_fields_are_absent() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        write(&path, &format!(r#"{{"endpoint":"https://telemetry.example.com","hostId":"h_0123456789abcdef0123456789abcdef","tokenFile":"{}"}}"#, token.display()), 0o600);
        let config = load(&path).unwrap();
        assert_eq!(config.upload_interval_ms, 30_000);
        assert_eq!(config.max_queue_samples, 16);
        assert_eq!(config.request_timeout_ms, 10_000);
    }

    #[test]
    fn rejects_group_readable_files_and_symlinks() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o644);
        let path = root.join("agent.json");
        write(&path, &valid_config(&token), 0o600);
        let config = load(&path).unwrap();
        assert!(load_token(&config).unwrap_err().to_string().contains("owner-only"));

        let link = root.join("token-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&token, &link).unwrap();
        let config_path = root.join("agent-link.json");
        write(&config_path, &valid_config(&link), 0o600);
        let config = load(&config_path).unwrap();
        assert!(load_token(&config).unwrap_err().to_string().contains("symbolic links"));
    }

    #[test]
    fn rejects_a_fifo_without_blocking() {
        let root = scratch();
        let fifo = root.join("token-fifo");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let config_path = root.join("agent-fifo.json");
        write(&config_path, &valid_config(&fifo), 0o600);
        let config = load(&config_path).unwrap();
        let started = std::time::Instant::now();
        let error = load_token(&config).unwrap_err().to_string();
        assert!(error.contains("not a regular file"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn rejects_remote_plain_http_and_bad_identity() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        let text = valid_config(&token).replace("https://telemetry.example.com", "http://telemetry.example.com");
        write(&path, &text, 0o600);
        assert!(load(&path).unwrap_err().to_string().contains("https"));

        let path = root.join("agent-bad.json");
        let text = valid_config(&token).replace("h_0123456789abcdef0123456789abcdef", "h_XYZ");
        write(&path, &text, 0o600);
        assert!(load(&path).unwrap_err().to_string().contains("hostId"));
    }

    #[test]
    fn loopback_http_is_allowed_for_local_tests() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        let text = valid_config(&token).replace("https://telemetry.example.com", "http://127.0.0.1:8787");
        write(&path, &text, 0o600);
        assert_eq!(load(&path).unwrap().endpoint, "http://127.0.0.1:8787");
    }

    #[test]
    fn resolves_the_optional_block_latency_file() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        let text = valid_config(&token).replace("\"requestTimeoutMs\":10000", "\"requestTimeoutMs\":10000,\"blockLatencyFile\":\"run/block.json\"");
        write(&path, &text, 0o600);
        let config = load(&path).unwrap();
        assert_eq!(config.block_latency_file, Some(root.join("run/block.json")));

        let path = root.join("agent-empty.json");
        let text = valid_config(&token).replace("\"requestTimeoutMs\":10000", "\"requestTimeoutMs\":10000,\"blockLatencyFile\":\"\"");
        write(&path, &text, 0o600);
        assert!(load(&path).unwrap_err().to_string().contains("blockLatencyFile"));
    }

    #[test]
    fn virtual_collection_is_off_unless_the_host_config_enables_it() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        write(&path, &valid_config(&token), 0o600);
        assert_eq!(load(&path).unwrap().scope(), CollectionScope::default());
        assert!(!CollectionScope::default().virtual_interfaces && !CollectionScope::default().virtual_filesystems);

        let path = root.join("agent-virtual.json");
        let text = valid_config(&token).replace('}', r#","includeVirtualInterfaces":true,"includeVirtualFilesystems":true}"#);
        write(&path, &text, 0o600);
        let scope = load(&path).unwrap().scope();
        assert!(scope.virtual_interfaces && scope.virtual_filesystems);
    }

    #[test]
    fn rejects_intervals_below_the_serving_contract() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);

        let sample_path = root.join("agent-fast-sample.json");
        let text = valid_config(&token).replace("\"sampleIntervalMs\":15000", "\"sampleIntervalMs\":14999");
        write(&sample_path, &text, 0o600);
        assert!(load(&sample_path).unwrap_err().to_string().contains("15000"));

        let upload_path = root.join("agent-fast-upload.json");
        let text = valid_config(&token).replace("\"uploadIntervalMs\":30000", "\"uploadIntervalMs\":9999");
        write(&upload_path, &text, 0o600);
        assert!(load(&upload_path).unwrap_err().to_string().contains("10000"));
    }

    #[test]
    fn rejects_a_request_timeout_past_the_stop_budget() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", 0o600);
        let path = root.join("agent.json");
        let text = valid_config(&token).replace("\"requestTimeoutMs\":10000", "\"requestTimeoutMs\":30001");
        write(&path, &text, 0o600);
        assert!(load(&path).unwrap_err().to_string().contains("30000"));
    }

    #[test]
    fn rejects_bad_token_and_unknown_fields() {
        let root = scratch();
        let token = root.join("token");
        write(&token, "nft_short", 0o600);
        let path = root.join("agent.json");
        write(&path, &valid_config(&token), 0o600);
        assert!(load_token(&load(&path).unwrap()).unwrap_err().to_string().contains("43"));

        let path = root.join("agent-extra.json");
        let text = valid_config(&token).replace('}', r#","extra":true}"#);
        write(&path, &text, 0o600);
        assert!(load(&path).unwrap_err().to_string().contains("extra"));
    }
}
