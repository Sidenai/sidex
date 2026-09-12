//! Host and VSIX target-platform helpers.
//!
//! VS Code identifies platform-specific extension builds with a
//! `targetPlatform` string (`win32-x64`, `darwin-arm64`, `linux-x64`, …).
//! The value lives in two places:
//!
//! - the gallery response (`versions[].targetPlatform`), which the client
//!   uses to filter out builds for other machines, and
//! - the `.vsix` itself: `<Identity … TargetPlatform="win32-x64"/>` inside
//!   `extension.vsixmanifest`.
//!
//! Registry searches are not platform-aware. Open VSX's `/api/-/search`
//! hands back whichever build sorts first — `alpine-arm64` — for every
//! extension published per platform, and a gallery proxy that drops the
//! `targetPlatform` field leaves the client unable to notice. The install
//! path therefore has to inspect the package it actually received; that is
//! what this module is for.

/// Target-platform values that mean "runs anywhere".
pub const AGNOSTIC_TARGET_PLATFORMS: &[&str] =
    &["", "universal", "undefined", "unknown", "web", "none"];

/// The target platform of this machine, in VS Code nomenclature.
pub fn host_target_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("windows", "x86") => "win32-ia32",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armhf",
        // Anything we cannot name is treated as platform-agnostic so the
        // guard never blocks an install it does not understand.
        _ => "universal",
    }
}

/// True when `declared` either says nothing about the platform or matches
/// `host`.
pub fn is_target_platform_compatible(declared: Option<&str>, host: &str) -> bool {
    let Some(value) = declared else {
        return true;
    };
    let value = value.trim();
    if AGNOSTIC_TARGET_PLATFORMS
        .iter()
        .any(|agnostic| agnostic.eq_ignore_ascii_case(value))
    {
        return true;
    }
    value.eq_ignore_ascii_case(host)
}

/// Reads an attribute out of the `<Identity …/>` element of an
/// `extension.vsixmanifest` document.
///
/// Deliberately a hand-rolled scan rather than a full XML parse: the
/// element is a flat, attribute-only tag, and pulling in an XML stack for
/// one attribute is not worth the build time or the dependency surface.
pub fn vsix_identity_attr(xml: &str, attr: &str) -> Option<String> {
    let start = xml.find("<Identity")?;
    let tag = &xml[start..];
    let end = tag.find('>')?;
    let tag = &tag[..end];

    let needle = format!("{attr}=\"");
    let at = tag.find(&needle)?;
    let after = &tag[at + needle.len()..];
    let close = after.find('"')?;
    let value = after[..close].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// `TargetPlatform` declared by a VSIX manifest (`extension.vsixmanifest`).
pub fn target_platform_from_vsix_manifest(xml: &str) -> Option<String> {
    vsix_identity_attr(xml, "TargetPlatform")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim shape taken from a real Open VSX package
    /// (`Anthropic.claude-code` win32-x64 build).
    const MANIFEST_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
	<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
		<Metadata>
			<Identity Language="en-US" Id="claude-code" Version="2.1.269" Publisher="Anthropic" TargetPlatform="win32-x64"/>
			<DisplayName>Claude Code for VS Code</DisplayName>
		</Metadata>
	</PackageManifest>"#;

    #[test]
    fn host_platform_is_a_known_identifier() {
        let host = host_target_platform();
        assert!(!host.is_empty());
        assert!(
            host == "universal"
                || host.starts_with("win32-")
                || host.starts_with("darwin-")
                || host.starts_with("linux-"),
            "unexpected host platform {host}"
        );
    }

    #[test]
    fn parses_identity_attributes() {
        assert_eq!(
            target_platform_from_vsix_manifest(MANIFEST_XML).as_deref(),
            Some("win32-x64")
        );
        assert_eq!(
            vsix_identity_attr(MANIFEST_XML, "Publisher").as_deref(),
            Some("Anthropic")
        );
        assert_eq!(
            vsix_identity_attr(MANIFEST_XML, "Id").as_deref(),
            Some("claude-code")
        );
        assert_eq!(
            vsix_identity_attr(MANIFEST_XML, "Version").as_deref(),
            Some("2.1.269")
        );
    }

    #[test]
    fn missing_identity_element_yields_none() {
        assert_eq!(target_platform_from_vsix_manifest("<PackageManifest/>"), None);
        assert_eq!(vsix_identity_attr("", "Publisher"), None);
    }

    #[test]
    fn platform_less_packages_are_always_compatible() {
        for agnostic in [None, Some(""), Some("universal"), Some("WEB"), Some("undefined")] {
            assert!(
                is_target_platform_compatible(agnostic, "win32-x64"),
                "{agnostic:?} should be treated as platform-agnostic"
            );
        }
    }

    #[test]
    fn foreign_platform_is_rejected() {
        // The exact bug this module exists for: Open VSX hands out the
        // alphabetically first build, which for claude-code is alpine-arm64.
        assert!(!is_target_platform_compatible(Some("alpine-arm64"), "win32-x64"));
        assert!(!is_target_platform_compatible(Some("linux-x64"), "win32-x64"));
        assert!(!is_target_platform_compatible(Some("darwin-arm64"), "win32-x64"));
    }

    #[test]
    fn matching_platform_is_accepted_case_insensitively() {
        assert!(is_target_platform_compatible(Some("win32-x64"), "win32-x64"));
        assert!(is_target_platform_compatible(Some("WIN32-X64"), "win32-x64"));
        assert!(is_target_platform_compatible(Some(" win32-x64 "), "win32-x64"));
    }
}
