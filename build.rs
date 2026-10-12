//! Stamps the binary with the commit it was built from: UMS_BUILD_SHA when the build sets
//! it (CI does), else what git says, else `unknown`.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=UMS_BUILD_SHA");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");
    let sha = std::env::var("UMS_BUILD_SHA")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let out = Command::new("git")
                .args(["rev-parse", "--short=12", "HEAD"])
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "unknown".to_string());
    let short: String = sha.chars().take(12).collect();
    println!("cargo:rustc-env=UMS_BUILD_SHA={short}");
}
