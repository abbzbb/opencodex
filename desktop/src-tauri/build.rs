use std::fs;
use std::path::PathBuf;

fn sidecar_source_name(target: &str) -> String {
    if target.contains("windows") {
        format!("ocx-runtime-{target}.exe")
    } else {
        format!("ocx-runtime-{target}")
    }
}

fn unix_stub() -> Vec<u8> {
    b"#!/bin/sh\necho OCX_DESKTOP_SIDECAR_STUB >&2\nexit 2\n".to_vec()
}

fn windows_stub() -> Vec<u8> {
    b"MZOCX_DESKTOP_SIDECAR_STUB".to_vec()
}

fn ensure_sidecar_source(target: &str) {
    let filename = sidecar_source_name(target);
    let dir = PathBuf::from("binaries");
    let path = dir.join(&filename);
    println!("cargo:rerun-if-changed={}", path.display());
    if path
        .symlink_metadata()
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
    {
        return;
    }
    fs::create_dir_all(&dir).expect("create sidecar directory");
    let bytes = if target.contains("windows") {
        windows_stub()
    } else {
        unix_stub()
    };
    fs::write(&path, bytes).expect("write sidecar placeholder");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !target.contains("windows") {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("mark sidecar placeholder executable");
        }
    }
}

fn main() {
    let target = std::env::var("TARGET").expect("TARGET is set by cargo");
    println!("cargo:rustc-env=OCX_CARGO_TARGET={target}");
    ensure_sidecar_source(&target);
    tauri_build::build();
}
