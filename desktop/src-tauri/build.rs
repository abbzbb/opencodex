use std::fs;
use std::io::Read;
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

fn u16_at(bytes: &[u8], offset: usize, little: bool) -> Option<u16> {
    let pair: [u8; 2] = bytes.get(offset..offset + 2)?.try_into().ok()?;
    Some(if little {
        u16::from_le_bytes(pair)
    } else {
        u16::from_be_bytes(pair)
    })
}

fn u32_at(bytes: &[u8], offset: usize, little: bool) -> Option<u32> {
    let word: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(if little {
        u32::from_le_bytes(word)
    } else {
        u32::from_be_bytes(word)
    })
}

fn binary_matches_target(header: &[u8], target: &str) -> bool {
    let arm64 = target.starts_with("aarch64-");
    if target.contains("linux") {
        if header.get(..4) != Some(b"\x7fELF")
            || header.get(4) != Some(&2)
            || !matches!(header.get(5), Some(1 | 2))
        {
            return false;
        }
        let little = header.get(5) == Some(&1);
        return u16_at(header, 18, little) == Some(if arm64 { 183 } else { 62 });
    }
    if target.contains("windows") {
        if header.get(..2) != Some(b"MZ") {
            return false;
        }
        let Some(pe_offset) = u32_at(header, 0x3c, true).map(|value| value as usize) else {
            return false;
        };
        return header.get(pe_offset..pe_offset + 4) == Some(b"PE\0\0")
            && u16_at(header, pe_offset + 4, true) == Some(if arm64 { 0xaa64 } else { 0x8664 });
    }
    let little = u32_at(header, 0, true) == Some(0xfeedfacf);
    if !little && u32_at(header, 0, false) != Some(0xfeedfacf) {
        return false;
    }
    u32_at(header, 4, little) == Some(if arm64 { 0x0100000c } else { 0x01000007 })
}

fn is_real_runtime(path: &std::path::Path, target: &str) -> bool {
    let Ok(meta) = path.symlink_metadata() else {
        return false;
    };
    if !meta.file_type().is_file() || meta.len() < 4096 {
        return false;
    }
    #[cfg(unix)]
    if !target.contains("windows") {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 4096];
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    let header = &header[..read];
    !String::from_utf8_lossy(header).contains("OCX_DESKTOP_SIDECAR_STUB")
        && binary_matches_target(header, target)
}

fn ensure_sidecar_source(target: &str) {
    let filename = sidecar_source_name(target);
    let dir = PathBuf::from("binaries");
    let path = dir.join(&filename);
    let resource_path = PathBuf::from("resources/runtime").join(&filename);
    let resource_manifest = PathBuf::from("resources/runtime/runtime-manifest.json");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-changed={}", resource_path.display());
    println!("cargo:rerun-if-changed={}", resource_manifest.display());
    if !release && is_real_runtime(&path, target) {
        return;
    }
    let manifest_is_file = resource_manifest
        .symlink_metadata()
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false);
    if is_real_runtime(&resource_path, target) && manifest_is_file {
        fs::create_dir_all(&dir).expect("create sidecar directory");
        fs::copy(&resource_path, &path).expect("copy target runtime sidecar source");
        #[cfg(unix)]
        if !target.contains("windows") {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("mark runtime sidecar executable");
        }
        return;
    }
    if release {
        panic!(
            "release build requires a real target runtime payload; run desktop build:runtime first"
        );
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
