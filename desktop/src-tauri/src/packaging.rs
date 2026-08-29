use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::codec::UTF8_BOM;

pub const SIDECAR_BIN_NAME: &str = "ocx-runtime";
pub const SIDECAR_CONFIG_PATH: &str = "binaries/ocx-runtime";
pub const RUNTIME_RESOURCE_REL: &str = "resources/runtime";
pub const STABLE_RUNTIME_DIR_NAME: &str = "runtime";
pub const CURRENT_POINTER_NAME: &str = "current.json";
pub const STABLE_VERSIONS_DIR: &str = "versions";
pub const BRIDGE_SCRIPT_REL: &str = "desktop/runtime/bootstrap.ts";
pub const INSTALL_SCRIPT_REL: &str = "desktop/runtime/install.ts";
pub const DEBUG_BRIDGE_BIN_ENV: &str = "OCX_DESKTOP_BRIDGE_BIN";
pub const DEBUG_RUNTIME_ROOT_ENV: &str = "OCX_DESKTOP_RUNTIME_ROOT";
pub const SIDECAR_STUB_MARKER: &str = "OCX_DESKTOP_SIDECAR_STUB";
pub const MAX_POINTER_BYTES: usize = 64 * 1024;

pub const TARGET_TRIPLES: [&str; 6] = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
];

const POINTER_KEYS: [&str; 3] = ["schemaVersion", "current", "previous"];
const VERSION_POINTER_KEYS: [&str; 4] = ["id", "version", "target", "relPath"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveError {
    message: String,
}

impl ResolveError {
    fn new(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }

    pub fn code(&self) -> &'static str {
        "runtime_integrity_failed"
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionPointer {
    pub id: String,
    pub version: String,
    pub target: String,
    pub rel_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentPointer {
    pub current: VersionPointer,
    pub previous: Option<VersionPointer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLayout {
    pub sidecar_dir: PathBuf,
    pub resource_runtime_dir: Option<PathBuf>,
    pub stable_root: PathBuf,
    pub target_triple: String,
    pub allow_debug_env: bool,
    pub debug_program: Option<PathBuf>,
    pub debug_cwd: Option<PathBuf>,
}

pub fn is_target_triple(value: &str) -> bool {
    TARGET_TRIPLES.contains(&value)
}

fn is_windows_triple(triple: &str) -> bool {
    triple.contains("windows")
}

fn is_runtime_version(value: &str) -> bool {
    if value == "." || value == ".." {
        return false;
    }
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    if value.contains('/') || value.contains('\\') || value.contains(':') {
        return false;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn is_manifest_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value.contains("..") || value.contains('/') || value.contains('\\') || value.contains(':') {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

pub fn compiled_target_triple() -> Result<&'static str, ResolveError> {
    let triple = option_env!("TAURI_ENV_TARGET_TRIPLE")
        .or(option_env!("OCX_CARGO_TARGET"))
        .ok_or_else(|| ResolveError::new("unsupported target triple"))?;
    if is_target_triple(triple) {
        Ok(triple)
    } else {
        Err(ResolveError::new("unsupported target triple"))
    }
}

pub fn debug_env_selection_allowed() -> bool {
    cfg!(debug_assertions)
}

pub fn packaged_sidecar_file_name() -> &'static str {
    if cfg!(windows) {
        "ocx-runtime.exe"
    } else {
        "ocx-runtime"
    }
}

pub fn sidecar_source_file_name(triple: &str) -> Result<String, ResolveError> {
    if !is_target_triple(triple) {
        return Err(ResolveError::new("unsupported target triple"));
    }
    if is_windows_triple(triple) {
        Ok(format!("{SIDECAR_BIN_NAME}-{triple}.exe"))
    } else {
        Ok(format!("{SIDECAR_BIN_NAME}-{triple}"))
    }
}

pub fn is_allowed_sidecar_file_name(name: &str, triple: &str) -> bool {
    if name == packaged_sidecar_file_name() {
        return true;
    }
    sidecar_source_file_name(triple)
        .map(|expected| expected == name)
        .unwrap_or(false)
}

fn as_object(value: &Value) -> Result<&Map<String, Value>, ResolveError> {
    match value {
        Value::Object(map) => {
            if map.contains_key("__proto__")
                || map.contains_key("constructor")
                || map.contains_key("prototype")
            {
                return Err(ResolveError::new("runtime current pointer is invalid"));
            }
            Ok(map)
        }
        _ => Err(ResolveError::new("runtime current pointer is invalid")),
    }
}

fn exact_keys(value: &Map<String, Value>, expected: &[&str]) -> Result<(), ResolveError> {
    if value.len() != expected.len()
        || expected.iter().any(|key| !value.contains_key(*key))
        || value.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    Ok(())
}

fn lstat(path: &Path) -> Result<fs::Metadata, ResolveError> {
    fs::symlink_metadata(path).map_err(|_| ResolveError::new("runtime path is not readable"))
}

fn reject_symlink(meta: &fs::Metadata, message: &str) -> Result<(), ResolveError> {
    if meta.file_type().is_symlink() {
        return Err(ResolveError::new(message));
    }
    Ok(())
}

fn is_unix_executable(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

fn validate_relative_posix(path: &str) -> Result<Vec<&str>, ResolveError> {
    if path.is_empty() || path.len() > 240 {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') || path.contains('\0') {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    if path.contains("//") {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    Ok(segments)
}

fn path_has_parent_dir(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn contained_join(root: &Path, posix_rel: &str) -> Result<PathBuf, ResolveError> {
    if path_has_parent_dir(root) {
        return Err(ResolveError::new("runtime path is not contained"));
    }
    let segments = validate_relative_posix(posix_rel)?;
    let root_meta = lstat(root)?;
    reject_symlink(&root_meta, "runtime path is not a regular directory")?;
    if !root_meta.is_dir() {
        return Err(ResolveError::new("runtime path is not a regular directory"));
    }
    let mut current = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        if !current.starts_with(root) {
            return Err(ResolveError::new("runtime path is not contained"));
        }
        let meta = lstat(&current)?;
        reject_symlink(&meta, "runtime path must not be a symlink")?;
        let last = index + 1 == segments.len();
        if !last && !meta.is_dir() {
            return Err(ResolveError::new("runtime path is not a regular directory"));
        }
    }
    Ok(current)
}

pub fn validate_regular_executable(path: &Path) -> Result<(), ResolveError> {
    if path.as_os_str().is_empty() || path_has_parent_dir(path) {
        return Err(ResolveError::new("packaged runtime bridge is missing"));
    }
    let meta = lstat(path).map_err(|_| ResolveError::new("packaged runtime bridge is missing"))?;
    reject_symlink(&meta, "packaged runtime bridge is not a regular file")?;
    if !meta.is_file() {
        return Err(ResolveError::new(
            "packaged runtime bridge is not a regular file",
        ));
    }
    if !is_unix_executable(&meta) {
        return Err(ResolveError::new(
            "packaged runtime bridge is not executable",
        ));
    }
    Ok(())
}

fn reject_compile_stub(path: &Path) -> Result<(), ResolveError> {
    let mut file =
        File::open(path).map_err(|_| ResolveError::new("packaged runtime bridge is missing"))?;
    let mut buf = [0u8; 128];
    let n = file
        .read(&mut buf)
        .map_err(|_| ResolveError::new("packaged runtime bridge is missing"))?;
    if String::from_utf8_lossy(&buf[..n]).contains(SIDECAR_STUB_MARKER) {
        return Err(ResolveError::new("packaged runtime bridge is missing"));
    }
    Ok(())
}

fn validate_named_sidecar(path: &Path, triple: &str) -> Result<(), ResolveError> {
    validate_regular_executable(path)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ResolveError::new("packaged runtime bridge has an unexpected name"))?;
    if !is_allowed_sidecar_file_name(name, triple) {
        return Err(ResolveError::new(
            "packaged runtime bridge has an unexpected name",
        ));
    }
    reject_compile_stub(path)
}

pub fn validate_directory(path: &Path) -> Result<(), ResolveError> {
    if path.as_os_str().is_empty() || path_has_parent_dir(path) {
        return Err(ResolveError::new("runtime path is not a regular directory"));
    }
    let meta = lstat(path)?;
    reject_symlink(&meta, "runtime path is not a regular directory")?;
    if !meta.is_dir() {
        return Err(ResolveError::new("runtime path is not a regular directory"));
    }
    Ok(())
}

pub fn parse_version_pointer(value: &Value) -> Result<VersionPointer, ResolveError> {
    let obj = as_object(value)?;
    exact_keys(obj, &VERSION_POINTER_KEYS)?;
    let id = obj["id"]
        .as_str()
        .filter(|value| is_manifest_id(value))
        .ok_or_else(|| ResolveError::new("runtime current pointer is invalid"))?;
    let version = obj["version"]
        .as_str()
        .filter(|value| is_runtime_version(value))
        .ok_or_else(|| ResolveError::new("runtime current pointer is invalid"))?;
    let target = obj["target"]
        .as_str()
        .filter(|value| is_target_triple(value))
        .ok_or_else(|| ResolveError::new("runtime current pointer is invalid"))?;
    let rel_path = obj["relPath"]
        .as_str()
        .ok_or_else(|| ResolveError::new("runtime current pointer is invalid"))?;
    validate_relative_posix(rel_path)?;
    if rel_path != format!("{STABLE_VERSIONS_DIR}/{version}") {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    Ok(VersionPointer {
        id: id.to_string(),
        version: version.to_string(),
        target: target.to_string(),
        rel_path: rel_path.to_string(),
    })
}

pub fn parse_current_pointer(value: &Value) -> Result<CurrentPointer, ResolveError> {
    let obj = as_object(value)?;
    exact_keys(obj, &POINTER_KEYS)?;
    if obj["schemaVersion"].as_u64() != Some(1) {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    let current = parse_version_pointer(&obj["current"])?;
    let previous = if obj["previous"].is_null() {
        None
    } else {
        let parsed = parse_version_pointer(&obj["previous"])?;
        if parsed.version == current.version {
            return Err(ResolveError::new("runtime current pointer is invalid"));
        }
        Some(parsed)
    };
    Ok(CurrentPointer { current, previous })
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[..3] == UTF8_BOM {
        &bytes[3..]
    } else {
        bytes
    }
}

pub fn read_current_pointer(stable_root: &Path) -> Result<CurrentPointer, ResolveError> {
    validate_directory(stable_root)?;
    if CURRENT_POINTER_NAME.contains('/') || CURRENT_POINTER_NAME.contains('\\') {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    let pointer_path = stable_root.join(CURRENT_POINTER_NAME);
    if !pointer_path.starts_with(stable_root) {
        return Err(ResolveError::new("runtime path is not contained"));
    }
    let meta = match fs::symlink_metadata(&pointer_path) {
        Ok(meta) => meta,
        Err(_) => {
            return Err(ResolveError::new(
                "no published runtime current is available",
            ))
        }
    };
    reject_symlink(&meta, "runtime current pointer is not a regular file")?;
    if !meta.is_file() {
        return Err(ResolveError::new(
            "runtime current pointer is not a regular file",
        ));
    }
    if meta.len() as usize > MAX_POINTER_BYTES {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    let mut file = File::open(&pointer_path)
        .map_err(|_| ResolveError::new("no published runtime current is available"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| ResolveError::new("runtime current pointer is invalid"))?;
    if bytes.len() > MAX_POINTER_BYTES {
        return Err(ResolveError::new("runtime current pointer is invalid"));
    }
    let text = std::str::from_utf8(strip_bom(&bytes))
        .map_err(|_| ResolveError::new("runtime current pointer is invalid"))?;
    let value: Value = serde_json::from_str(text)
        .map_err(|_| ResolveError::new("runtime current pointer is invalid"))?;
    parse_current_pointer(&value)
}

pub fn select_published_cwd(
    stable_root: &Path,
    expected_target: &str,
) -> Result<PathBuf, ResolveError> {
    if !is_target_triple(expected_target) {
        return Err(ResolveError::new("unsupported target triple"));
    }
    let pointer = read_current_pointer(stable_root)?;
    if pointer.current.target != expected_target {
        return Err(ResolveError::new(
            "runtime current target does not match this app",
        ));
    }
    let cwd = contained_join(stable_root, &pointer.current.rel_path)?;
    let meta = lstat(&cwd)?;
    reject_symlink(&meta, "runtime current is not a regular directory")?;
    if !meta.is_dir() {
        return Err(ResolveError::new(
            "runtime current is not a regular directory",
        ));
    }
    require_bridge_script(&cwd)?;
    Ok(cwd)
}

pub fn discover_packaged_sidecar(
    sidecar_dir: &Path,
    triple: &str,
) -> Result<PathBuf, ResolveError> {
    if !is_target_triple(triple) {
        return Err(ResolveError::new("unsupported target triple"));
    }
    if sidecar_dir.as_os_str().is_empty() || path_has_parent_dir(sidecar_dir) {
        return Err(ResolveError::new("packaged runtime bridge is missing"));
    }
    let packaged = sidecar_dir.join(packaged_sidecar_file_name());
    if packaged.starts_with(sidecar_dir) && validate_named_sidecar(&packaged, triple).is_ok() {
        return Ok(packaged);
    }
    let source_name = sidecar_source_file_name(triple)?;
    let source = sidecar_dir.join(source_name);
    if source.starts_with(sidecar_dir) && validate_named_sidecar(&source, triple).is_ok() {
        return Ok(source);
    }
    Err(ResolveError::new("packaged runtime bridge is missing"))
}

pub fn resolve_resource_runtime_dir(resource_dir: &Path) -> Result<PathBuf, ResolveError> {
    let resolved = contained_join(resource_dir, RUNTIME_RESOURCE_REL)?;
    validate_directory(&resolved)?;
    Ok(resolved)
}

fn debug_env_path(allow_debug_env: bool, key: &str) -> Option<PathBuf> {
    if !allow_debug_env {
        return None;
    }
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn resolve_bridge_program(layout: &BridgeLayout) -> Result<PathBuf, ResolveError> {
    if layout.allow_debug_env {
        if let Some(path) = layout.debug_program.as_ref() {
            validate_regular_executable(path)?;
            return Ok(path.clone());
        }
    }
    discover_packaged_sidecar(&layout.sidecar_dir, &layout.target_triple)
}

fn require_bridge_script(cwd: &Path) -> Result<(), ResolveError> {
    let script = contained_join(cwd, BRIDGE_SCRIPT_REL)?;
    let script_meta = lstat(&script)
        .map_err(|_| ResolveError::new("runtime current is missing the bridge script"))?;
    reject_symlink(&script_meta, "runtime current is missing the bridge script")?;
    if !script_meta.is_file() {
        return Err(ResolveError::new(
            "runtime current is missing the bridge script",
        ));
    }
    Ok(())
}

pub fn require_install_script(cwd: &Path) -> Result<(), ResolveError> {
    let script = contained_join(cwd, INSTALL_SCRIPT_REL)?;
    let script_meta = lstat(&script)
        .map_err(|_| ResolveError::new("packaged runtime is missing the installer script"))?;
    reject_symlink(
        &script_meta,
        "packaged runtime is missing the installer script",
    )?;
    if !script_meta.is_file() {
        return Err(ResolveError::new(
            "packaged runtime is missing the installer script",
        ));
    }
    Ok(())
}

pub fn validate_spawn_paths(program: &Path, cwd: &Path) -> Result<(), ResolveError> {
    validate_regular_executable(program)?;
    validate_directory(cwd)?;
    require_bridge_script(cwd)
}

pub fn validate_installer_spawn_paths(program: &Path, cwd: &Path) -> Result<(), ResolveError> {
    validate_regular_executable(program)?;
    validate_directory(cwd)?;
    require_install_script(cwd)
}

pub fn should_run_packaged_staging(layout: &BridgeLayout) -> bool {
    !(layout.allow_debug_env && layout.debug_cwd.is_some())
}

pub fn resolve_packaged_runtime_source(layout: &BridgeLayout) -> Result<PathBuf, ResolveError> {
    let source = layout
        .resource_runtime_dir
        .as_ref()
        .ok_or_else(|| ResolveError::new("packaged runtime resources are unavailable"))?;
    validate_directory(source)?;
    require_install_script(source)?;
    Ok(source.clone())
}

pub fn resolve_bridge_cwd(layout: &BridgeLayout) -> Result<PathBuf, ResolveError> {
    if layout.allow_debug_env {
        if let Some(path) = layout.debug_cwd.as_ref() {
            validate_directory(path)?;
            require_bridge_script(path)?;
            return Ok(path.clone());
        }
    }
    select_published_cwd(&layout.stable_root, &layout.target_triple)
}

pub fn layout_from_app<R: Runtime>(app: &AppHandle<R>) -> Result<BridgeLayout, ResolveError> {
    let target_triple = compiled_target_triple()?.to_string();
    let exe = std::env::current_exe()
        .map_err(|_| ResolveError::new("packaged runtime bridge is missing"))?;
    let sidecar_dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| ResolveError::new("packaged runtime bridge is missing"))?;
    if tauri_external_bin_entry() != SIDECAR_CONFIG_PATH {
        return Err(ResolveError::new("packaged runtime bridge is missing"));
    }
    let allow_debug_env = debug_env_selection_allowed();
    let debug_program = debug_env_path(allow_debug_env, DEBUG_BRIDGE_BIN_ENV);
    let debug_cwd = debug_env_path(allow_debug_env, DEBUG_RUNTIME_ROOT_ENV);
    let resource_runtime_dir = if allow_debug_env && debug_cwd.is_some() {
        None
    } else {
        let resource_root = app
            .path()
            .resource_dir()
            .map_err(|_| ResolveError::new("packaged runtime resources are unavailable"))?;
        Some(resolve_resource_runtime_dir(&resource_root)?)
    };
    let stable_root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| ResolveError::new("no published runtime current is available"))?
        .join(STABLE_RUNTIME_DIR_NAME);
    Ok(BridgeLayout {
        sidecar_dir,
        resource_runtime_dir,
        stable_root,
        target_triple,
        allow_debug_env,
        debug_program,
        debug_cwd,
    })
}

pub fn tauri_external_bin_entry() -> &'static str {
    SIDECAR_CONFIG_PATH
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let id = UNIQUE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ocx-desktop-packaging-{}-{}",
                std::process::id(),
                id
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self, rel: &str) -> PathBuf {
            let mut path = self.root.clone();
            for segment in rel.split('/') {
                path.push(segment);
            }
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_file(path: &Path, contents: &[u8], executable: bool) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        file.write_all(contents).unwrap();
        drop(file);
        if executable {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }

    fn pointer_json(version: &str, target: &str) -> String {
        format!(
            "{{\n  \"schemaVersion\": 1,\n  \"current\": {{\n    \"id\": \"ocx-runtime-{version}-{target}\",\n    \"version\": \"{version}\",\n    \"target\": \"{target}\",\n    \"relPath\": \"versions/{version}\"\n  }},\n  \"previous\": null\n}}\n"
        )
    }

    fn publish_current(tree: &TempTree, version: &str, target: &str) -> PathBuf {
        let cwd = tree.path(&format!("versions/{version}"));
        write_file(
            &cwd.join("desktop/runtime/bootstrap.ts"),
            b"export {}\n",
            false,
        );
        write_file(
            &tree.path("current.json"),
            pointer_json(version, target).as_bytes(),
            false,
        );
        cwd
    }

    #[test]
    fn target_triples_match_the_closed_desktop_set() {
        assert_eq!(
            TARGET_TRIPLES,
            [
                "aarch64-apple-darwin",
                "x86_64-apple-darwin",
                "x86_64-pc-windows-msvc",
                "aarch64-pc-windows-msvc",
                "x86_64-unknown-linux-gnu",
                "aarch64-unknown-linux-gnu",
            ]
        );
        assert_eq!(
            sidecar_source_file_name("x86_64-unknown-linux-gnu").unwrap(),
            "ocx-runtime-x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            sidecar_source_file_name("aarch64-apple-darwin").unwrap(),
            "ocx-runtime-aarch64-apple-darwin"
        );
        assert_eq!(
            sidecar_source_file_name("x86_64-pc-windows-msvc").unwrap(),
            "ocx-runtime-x86_64-pc-windows-msvc.exe"
        );
        assert!(sidecar_source_file_name("x86_64-unknown-linux-musl").is_err());
        assert!(!is_allowed_sidecar_file_name(
            "bash",
            "x86_64-unknown-linux-gnu"
        ));
        assert_eq!(SIDECAR_CONFIG_PATH, "binaries/ocx-runtime");
        assert!(!SIDECAR_CONFIG_PATH.contains("x86_64"));
        assert_eq!(RUNTIME_RESOURCE_REL, "resources/runtime");
        assert_eq!(INSTALL_SCRIPT_REL, "desktop/runtime/install.ts");
    }

    #[test]
    fn sidecar_stub_marker_is_stable() {
        assert_eq!(SIDECAR_STUB_MARKER, "OCX_DESKTOP_SIDECAR_STUB");
    }

    #[test]
    fn packaged_sidecar_name_does_not_embed_a_triple() {
        let name = packaged_sidecar_file_name();
        assert!(name.starts_with(SIDECAR_BIN_NAME));
        assert!(!name.contains("unknown-linux"));
        assert!(!name.contains("apple-darwin"));
        assert!(!name.contains("windows-msvc"));
    }

    #[test]
    fn release_resolution_ignores_environment_overrides() {
        let tree = TempTree::new();
        let env_bin = tree.path("env-bin");
        write_file(&env_bin, b"#!/bin/sh\nexit 0\n", true);
        let sidecar = tree.path(packaged_sidecar_file_name());
        write_file(&sidecar, b"#!/bin/sh\nexit 0\n", true);
        let cwd = publish_current(&tree, "2.35.0", "x86_64-unknown-linux-gnu");
        let layout = BridgeLayout {
            sidecar_dir: tree.root.clone(),
            resource_runtime_dir: None,
            stable_root: tree.root.clone(),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            allow_debug_env: false,
            debug_program: Some(env_bin.clone()),
            debug_cwd: Some(PathBuf::from("/tmp")),
        };
        let program = resolve_bridge_program(&layout).unwrap();
        let resolved_cwd = resolve_bridge_cwd(&layout).unwrap();
        assert_eq!(program, sidecar);
        assert_eq!(resolved_cwd, cwd);
        assert_ne!(program, env_bin);
    }

    #[test]
    fn debug_env_program_must_be_a_regular_executable() {
        let tree = TempTree::new();
        let env_bin = tree.path("probe-bun");
        write_file(&env_bin, b"#!/bin/sh\nexit 0\n", true);
        let script_root = tree.path("runtime-root");
        write_file(
            &script_root.join("desktop/runtime/bootstrap.ts"),
            b"export {}\n",
            false,
        );
        let layout = BridgeLayout {
            sidecar_dir: tree.path("missing-sidecar-dir"),
            resource_runtime_dir: None,
            stable_root: tree.path("missing-stable"),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            allow_debug_env: true,
            debug_program: Some(env_bin.clone()),
            debug_cwd: Some(script_root.clone()),
        };
        let program = resolve_bridge_program(&layout).unwrap();
        let cwd = resolve_bridge_cwd(&layout).unwrap();
        assert_eq!(program, env_bin);
        assert_eq!(cwd, script_root);
        assert!(!should_run_packaged_staging(&layout));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_path_escape_fail_closed() {
        let tree = TempTree::new();
        let target = "x86_64-unknown-linux-gnu";
        let real_bin = tree.path("real-bin");
        write_file(&real_bin, b"#!/bin/sh\nexit 0\n", true);
        let link = tree.path(packaged_sidecar_file_name());
        std::os::unix::fs::symlink(&real_bin, &link).unwrap();
        let err = discover_packaged_sidecar(&tree.root, target).unwrap_err();
        assert_eq!(err.message(), "packaged runtime bridge is missing");
        assert!(!err.message().contains(tree.root.to_str().unwrap()));

        publish_current(&tree, "2.35.0", target);
        let version_dir = tree.path("versions/2.35.0");
        let swapped = tree.path("versions/swapped");
        fs::rename(&version_dir, &swapped).unwrap();
        std::os::unix::fs::symlink(&swapped, &version_dir).unwrap();
        let err = select_published_cwd(&tree.root, target).unwrap_err();
        assert_eq!(err.message(), "runtime path must not be a symlink");
        assert!(!err.message().contains('/'));

        let escape = serde_json::json!({
            "schemaVersion": 1,
            "current": {
                "id": "ocx-runtime-2.35.0-x86_64-unknown-linux-gnu",
                "version": "2.35.0",
                "target": target,
                "relPath": "versions/../secret"
            },
            "previous": null
        });
        assert!(parse_current_pointer(&escape).is_err());
    }

    #[test]
    fn current_pointer_rejects_unknown_fields_and_target_mismatch() {
        let ok = serde_json::from_str::<Value>(&pointer_json("2.35.0", "x86_64-unknown-linux-gnu"))
            .unwrap();
        assert!(parse_current_pointer(&ok).is_ok());

        let extra = serde_json::json!({
            "schemaVersion": 1,
            "current": ok["current"].clone(),
            "previous": null,
            "extra": true
        });
        assert!(parse_current_pointer(&extra).is_err());

        let tree = TempTree::new();
        publish_current(&tree, "2.35.0", "aarch64-unknown-linux-gnu");
        let err = select_published_cwd(&tree.root, "x86_64-unknown-linux-gnu").unwrap_err();
        assert_eq!(
            err.message(),
            "runtime current target does not match this app"
        );
        assert_eq!(err.code(), "runtime_integrity_failed");
    }

    #[test]
    fn missing_current_fails_closed_without_falling_back_to_dot() {
        let tree = TempTree::new();
        let sidecar = tree.path(packaged_sidecar_file_name());
        write_file(&sidecar, b"#!/bin/sh\nexit 0\n", true);
        let layout = BridgeLayout {
            sidecar_dir: tree.root.clone(),
            resource_runtime_dir: None,
            stable_root: tree.root.clone(),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            allow_debug_env: false,
            debug_program: None,
            debug_cwd: None,
        };
        let err = resolve_bridge_cwd(&layout).unwrap_err();
        assert_eq!(err.message(), "no published runtime current is available");
        assert_ne!(err.message(), ".");
    }

    #[test]
    fn resource_runtime_dir_rejects_parent_segments() {
        let tree = TempTree::new();
        write_file(&tree.path("resources/runtime/.keep"), b"", false);
        write_file(
            &tree.path("resources/runtime/desktop/runtime/install.ts"),
            b"export {}\n",
            false,
        );
        let resolved = resolve_resource_runtime_dir(&tree.root).unwrap();
        assert_eq!(resolved, tree.path("resources/runtime"));
        let layout = BridgeLayout {
            sidecar_dir: tree.root.clone(),
            resource_runtime_dir: Some(resolved.clone()),
            stable_root: tree.path("stable"),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            allow_debug_env: false,
            debug_program: None,
            debug_cwd: None,
        };
        assert!(should_run_packaged_staging(&layout));
        assert_eq!(resolve_packaged_runtime_source(&layout).unwrap(), resolved);
        assert!(validate_relative_posix("../secret").is_err());
        assert!(validate_relative_posix("/tmp/runtime").is_err());
    }

    #[test]
    fn packaged_runtime_source_requires_the_fixed_installer_script() {
        let tree = TempTree::new();
        fs::create_dir_all(tree.path("runtime")).unwrap();
        let layout = BridgeLayout {
            sidecar_dir: tree.root.clone(),
            resource_runtime_dir: Some(tree.path("runtime")),
            stable_root: tree.path("stable"),
            target_triple: "x86_64-unknown-linux-gnu".to_string(),
            allow_debug_env: false,
            debug_program: None,
            debug_cwd: None,
        };
        let err = resolve_packaged_runtime_source(&layout).unwrap_err();
        assert_eq!(err.code(), "runtime_integrity_failed");
        assert!(!err.message().contains(tree.root.to_str().unwrap()));
    }
}
