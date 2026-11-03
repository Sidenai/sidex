//! Provider credentials and local model discovery.
//!
//! SideX runs without an account. Every model request is made with credentials
//! the user already has, resolved from four sources in this precedence order:
//!
//!   1. `settings`     — a key the user typed into Settings → Models
//!   2. `env`          — `ANTHROPIC_API_KEY` and friends, already in their shell
//!   3. `cli`          — an existing Claude Code / Codex login (opt-in)
//!   4. `local`        — an OpenAI-compatible server on loopback (no key needed)
//!
//! Nothing here talks to sidex.dev, and nothing is read from another tool's
//! credential store unless the user has explicitly enabled that provider's
//! `cli` source.
//!
//! The `cli` source is also surfaced as a first-class "Connect account" flow
//! (`accounts_list` / `accounts_connect` / `accounts_disconnect`, below the
//! catalog and resolution code). It does not implement any OAuth handshake
//! against Anthropic or `OpenAI` — it only detects a login the official
//! `claude` / `codex` CLI already left on this machine and, with the user's
//! explicit opt-in, reuses it the same way those CLIs would.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::secrets::SecretsStore;

/// Where a resolved credential came from. Surfaced in the UI so the user can
/// see *why* a provider is working without revealing the key itself.
pub const SOURCE_SETTINGS: &str = "settings";
pub const SOURCE_ENV: &str = "env";
pub const SOURCE_CLI: &str = "cli";
pub const SOURCE_LOCAL: &str = "local";

/// Credential kinds. A console key and a CLI login are sent differently.
pub const AUTH_API_KEY: &str = "api_key";
pub const AUTH_OAUTH: &str = "oauth";

/// Anthropic rejects every REST call, key or OAuth alike, that omits this --
/// proven against the live API: `curl .../v1/models -H "Authorization: Bearer
/// <token>"` comes back `400 {"error":{"message":"anthropic-version: header
/// is required"}}`. Kept as a local const rather than imported: the Go server
/// (internal/ai/client.go) defines the same value independently, and this
/// crate has no dependency on it.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// ChatGPT-subscription logins from `codex login` are not valid on
/// `api.openai.com`. They are used against the Codex Responses host the
/// official CLI talks to. That host only accepts first-party Codex
/// originators (`codex_cli_rs`, `codex_vscode`, …); `sidex` is rejected
/// with 403 the same way a non-Claude-Code User-Agent is on Anthropic.
const OPENAI_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";
/// Floor used when `~/.codex/models_cache.json` is missing. GPT-5.6 models
/// reject older values (e.g. 0.50.0) with "requires a newer version of Codex".
const CODEX_CLIENT_VERSION: &str = "0.146.0";

/// Required, in addition to the version header, only when authenticating
/// with an OAuth token lifted from a Claude Code login -- a console API key
/// needs no beta opt-in.
const ANTHROPIC_OAUTH_BETA: &str = "oauth-2025-04-20";

/// Only the API key is a secret. Base URLs, the on/off switch and the CLI
/// opt-in are ordinary settings and are kept out of the OS keyring — routing
/// them through it buys no protection and costs the user a keychain access
/// prompt every time the app is rebuilt and re-signed.
///
/// Secret-store key for a provider's user-entered API key.
fn api_key_slot(provider: &str) -> String {
    format!("sidex.apikey.{provider}")
}

/// Secret-store key for a provider's base-URL override.
fn base_url_slot(provider: &str) -> String {
    format!("sidex.baseurl.{provider}")
}

/// Secret-store key for the per-provider "reuse my CLI login" opt-in.
fn cli_opt_in_slot(provider: &str) -> String {
    format!("sidex.cli-auth.{provider}")
}

/// Secret-store key for the explicit per-provider off switch. Distinct from
/// simply having no credential: a keyless local provider (Ollama, …) is
/// otherwise always "configured", so without this the user has no way to
/// turn one off — see `providers_set_enabled`.
fn provider_off_slot(provider: &str) -> String {
    format!("sidex.provider-off.{provider}")
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Stable id used everywhere else (`anthropic`, `openai`, …).
    pub id: &'static str,
    pub label: &'static str,
    /// Default OpenAI-compatible endpoint. Overridable per provider.
    pub default_base_url: &'static str,
    /// Environment variables checked, in order, for a key.
    pub env_vars: &'static [&'static str],
    /// Where the user gets a key. Empty for local/self-hosted providers.
    pub console_url: &'static str,
    /// True when the provider needs no key at all (loopback servers).
    pub keyless: bool,
}

/// Every provider SideX knows how to talk to out of the box.
///
/// This is not a closed set — `providers_save` accepts any id with a custom
/// base URL, which is how "some OpenAI-compatible thing I self-host" works.
pub const PROVIDERS: &[ProviderInfo] = &[
    ProviderInfo {
        id: "anthropic",
        label: "Anthropic",
        default_base_url: "https://api.anthropic.com/v1",
        env_vars: &["ANTHROPIC_API_KEY"],
        console_url: "https://console.anthropic.com/settings/keys",
        keyless: false,
    },
    ProviderInfo {
        id: "openai",
        label: "OpenAI",
        default_base_url: "https://api.openai.com/v1",
        env_vars: &["OPENAI_API_KEY"],
        console_url: "https://platform.openai.com/account/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "google",
        label: "Google AI Studio",
        default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        env_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        console_url: "https://aistudio.google.com/app/apikey",
        keyless: false,
    },
    ProviderInfo {
        id: "openrouter",
        label: "OpenRouter",
        default_base_url: "https://openrouter.ai/api/v1",
        env_vars: &["OPENROUTER_API_KEY"],
        console_url: "https://openrouter.ai/keys",
        keyless: false,
    },
    ProviderInfo {
        id: "groq",
        label: "Groq",
        default_base_url: "https://api.groq.com/openai/v1",
        env_vars: &["GROQ_API_KEY"],
        console_url: "https://console.groq.com/keys",
        keyless: false,
    },
    ProviderInfo {
        id: "mistral",
        label: "Mistral",
        default_base_url: "https://api.mistral.ai/v1",
        env_vars: &["MISTRAL_API_KEY"],
        console_url: "https://console.mistral.ai/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "deepseek",
        label: "DeepSeek",
        default_base_url: "https://api.deepseek.com/v1",
        env_vars: &["DEEPSEEK_API_KEY"],
        console_url: "https://platform.deepseek.com/api_keys",
        keyless: false,
    },
    ProviderInfo {
        id: "moonshot",
        label: "Moonshot (Kimi)",
        default_base_url: "https://api.moonshot.cn/v1",
        env_vars: &["MOONSHOT_API_KEY"],
        console_url: "https://platform.moonshot.cn/console/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "zhipu",
        label: "Zhipu (GLM)",
        default_base_url: "https://open.bigmodel.cn/api/paas/v4",
        env_vars: &["ZHIPU_API_KEY"],
        console_url: "https://open.bigmodel.cn/usercenter/apikeys",
        keyless: false,
    },
    ProviderInfo {
        id: "xai",
        label: "xAI (Grok)",
        default_base_url: "https://api.x.ai/v1",
        env_vars: &["XAI_API_KEY"],
        console_url: "https://console.x.ai",
        keyless: false,
    },
    ProviderInfo {
        id: "together",
        label: "Together AI",
        default_base_url: "https://api.together.xyz/v1",
        env_vars: &["TOGETHER_API_KEY"],
        console_url: "https://api.together.xyz/settings/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "cerebras",
        label: "Cerebras",
        default_base_url: "https://api.cerebras.ai/v1",
        env_vars: &["CEREBRAS_API_KEY"],
        console_url: "https://cloud.cerebras.ai",
        keyless: false,
    },
    ProviderInfo {
        id: "fireworks",
        label: "Fireworks AI",
        default_base_url: "https://api.fireworks.ai/inference/v1",
        env_vars: &["FIREWORKS_API_KEY"],
        console_url: "https://app.fireworks.ai/settings/users/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "deepinfra",
        label: "DeepInfra",
        default_base_url: "https://api.deepinfra.com/v1/openai",
        env_vars: &["DEEPINFRA_API_KEY"],
        console_url: "https://deepinfra.com/dash/api_keys",
        keyless: false,
    },
    ProviderInfo {
        id: "perplexity",
        label: "Perplexity",
        // Perplexity is retiring its classic `/chat/completions` (Sonar)
        // surface into what it now calls the Agent API; `/v1` is the base
        // its own docs give for OpenAI-SDK-style requests going forward.
        default_base_url: "https://api.perplexity.ai/v1",
        env_vars: &["PERPLEXITY_API_KEY"],
        console_url: "https://console.perplexity.ai/project/keys",
        keyless: false,
    },
    ProviderInfo {
        id: "hyperbolic",
        label: "Hyperbolic",
        default_base_url: "https://api.hyperbolic.xyz/v1",
        env_vars: &["HYPERBOLIC_API_KEY"],
        console_url: "https://app.hyperbolic.ai/settings/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "nebius",
        label: "Nebius Token Factory",
        default_base_url: "https://api.tokenfactory.nebius.com/v1",
        env_vars: &["NEBIUS_API_KEY"],
        console_url: "https://tokenfactory.nebius.com/project/api-keys",
        keyless: false,
    },
    ProviderInfo {
        id: "sambanova",
        label: "SambaNova Cloud",
        default_base_url: "https://api.sambanova.ai/v1",
        env_vars: &["SAMBANOVA_API_KEY"],
        console_url: "https://cloud.sambanova.ai/apis",
        keyless: false,
    },
    ProviderInfo {
        id: "novita",
        label: "Novita AI",
        default_base_url: "https://api.novita.ai/openai",
        env_vars: &["NOVITA_API_KEY"],
        console_url: "https://novita.ai/settings/key-management",
        keyless: false,
    },
    ProviderInfo {
        id: "anyscale",
        label: "Anyscale",
        // Anyscale's self-serve multi-tenant Endpoints product still
        // documents this base URL/key pair, though since Aug 2024 new
        // access goes through Anyscale's enterprise-hosted platform rather
        // than open signup -- kept here for the users who already have a key.
        default_base_url: "https://api.endpoints.anyscale.com/v1",
        env_vars: &["ANYSCALE_API_KEY"],
        console_url: "https://app.endpoints.anyscale.com/credentials",
        keyless: false,
    },
    ProviderInfo {
        id: "openai-compatible",
        label: "OpenAI-compatible (custom)",
        // Deliberately empty: this is the escape hatch for a self-hosted or
        // aggregator endpoint that isn't in the catalog above, and there is
        // no default that would be meaningful for it. An empty string here
        // (not merely a missing override) is what makes the base-URL
        // fallback in `resolve_ignoring_enabled` refuse to resolve this
        // provider until the user supplies one.
        default_base_url: "",
        env_vars: &[],
        console_url: "",
        keyless: false,
    },
    ProviderInfo {
        id: "bedrock",
        label: "AWS Bedrock",
        // Region-specific: there is no global Bedrock endpoint, and the region
        // is parsed back out of this host for SigV4's credential scope.
        default_base_url: "",
        // AWS credentials are a pair, not a single value, so they cannot be
        // picked up from one variable. The key is entered in Settings as
        // `AccessKeyID:SecretAccessKey` (plus `:SessionToken` for STS).
        env_vars: &[],
        console_url: "https://console.aws.amazon.com/bedrock",
        keyless: false,
    },
    ProviderInfo {
        id: "ollama",
        label: "Ollama",
        default_base_url: "http://127.0.0.1:11434/v1",
        env_vars: &[],
        console_url: "",
        keyless: true,
    },
    ProviderInfo {
        id: "lmstudio",
        label: "LM Studio",
        default_base_url: "http://127.0.0.1:1234/v1",
        env_vars: &[],
        console_url: "",
        keyless: true,
    },
    ProviderInfo {
        id: "llamacpp",
        label: "llama.cpp",
        default_base_url: "http://127.0.0.1:8080/v1",
        env_vars: &[],
        console_url: "",
        keyless: true,
    },
    ProviderInfo {
        id: "vllm",
        label: "vLLM",
        default_base_url: "http://127.0.0.1:8000/v1",
        env_vars: &[],
        console_url: "",
        keyless: true,
    },
];

fn provider_info(id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Providers that are OpenAI-compatible servers on loopback, in probe order.
const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio", "llamacpp", "vllm"];

#[tauri::command]
pub fn providers_catalog() -> Vec<ProviderInfo> {
    PROVIDERS.to_vec()
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub base_url: String,
    /// True when a usable API key / keyless server was found. Independent of
    /// `enabled` — a disabled row still shows the typed key. A Claude Code /
    /// Codex login is NOT this flag; that is the Connect row.
    pub configured: bool,
    /// Which of the four sources supplied it. `None` when unconfigured.
    pub source: Option<String>,
    pub keyless: bool,
    /// Set when `source == "env"`, so the UI can say which variable won.
    pub env_var: Option<String>,
    /// False when the user has explicitly switched this provider off via
    /// `providers_set_enabled`. Drives the settings toggle; `configured`
    /// drives whether the provider can actually be used.
    pub enabled: bool,
}

/// A credential ready to be handed to the model server. The key is only ever
/// passed to the loopback server process — it is never logged or returned to
/// the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProvider {
    pub provider: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub source: String,
    /// `api_key` for a console key, `oauth` for a token lifted from a CLI
    /// login. Only Anthropic changes its header scheme based on this.
    pub auth_mode: String,
    /// ChatGPT account id from a Codex login. Required as `ChatGPT-Account-ID`
    /// on the Codex Responses host; unused for every other provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// Resolve one provider's credential without revealing it.
///
/// The API-key toggle (`provider_disabled`) and Claude Code / Codex Connect
/// (`cli_opt_in`) are independent. Turning the Anthropic key row off must not
/// drop a connected Claude login, and connecting Claude must not flip the key
/// row on. A typed/env key still wins when that row is on, so billed keys are
/// never silently replaced by a subscription token.
fn resolve_inner(store: &SecretsStore, id: &str) -> Option<ResolvedProvider> {
    if !provider_disabled(store, id) {
        if let Some(resolved) = resolve_direct_credential(store, id) {
            return Some(resolved);
        }
    }
    resolve_cli_credential(store, id)
}

/// Settings / env / keyless resolution, deaf to the off switch. Used by
/// `providers_status` so the API Keys row still shows the typed key while
/// the toggle is off — not a CLI login, which has its own Connect row.
fn resolve_ignoring_enabled(store: &SecretsStore, id: &str) -> Option<ResolvedProvider> {
    resolve_direct_credential(store, id)
}

fn provider_base_url(store: &SecretsStore, id: &str) -> Option<String> {
    let info = provider_info(id);
    store
        .inner
        .get_plain(&base_url_slot(id))
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var(format!("SIDEX_PROVIDER_{}_BASE_URL", id.to_uppercase()))
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        // `openai-compatible`'s catalog entry deliberately has an empty
        // `default_base_url` (there is no sensible one) -- filtered out here
        // too, not just at the settings/env steps, so that empty string can
        // never stand in for "no base URL supplied" and the `?` below
        // actually fails resolution for it until the user provides one.
        .or_else(|| {
            info.map(|i| i.default_base_url.to_string())
                .filter(|s| !s.is_empty())
        })
}

fn resolve_direct_credential(store: &SecretsStore, id: &str) -> Option<ResolvedProvider> {
    let info = provider_info(id);
    let base_url = provider_base_url(store, id)?;

    // 1. Explicit key from Settings.
    if let Ok(Some(key)) = store.inner.get(&api_key_slot(id)) {
        if !key.trim().is_empty() {
            return Some(ResolvedProvider {
                provider: id.to_string(),
                base_url,
                api_key: Some(key),
                source: SOURCE_SETTINGS.to_string(),
                auth_mode: AUTH_API_KEY.to_string(),
                account_id: None,
            });
        }
    }

    // 2. Environment.
    if let Some(info) = info {
        for var in info.env_vars {
            if let Ok(val) = std::env::var(var) {
                if !val.trim().is_empty() {
                    return Some(ResolvedProvider {
                        provider: id.to_string(),
                        base_url,
                        api_key: Some(val),
                        source: SOURCE_ENV.to_string(),
                        auth_mode: AUTH_API_KEY.to_string(),
                        account_id: None,
                    });
                }
            }
        }
    }

    // 3. Loopback servers need no credential at all.
    if info.is_some_and(|i| i.keyless) {
        return Some(ResolvedProvider {
            provider: id.to_string(),
            base_url,
            api_key: None,
            source: SOURCE_LOCAL.to_string(),
            auth_mode: AUTH_API_KEY.to_string(),
            account_id: None,
        });
    }

    None
}

/// A connected Claude Code / Codex login. Independent of the API-key toggle:
/// Connect is the opt-in, not the Anthropic/OpenAI row above it.
fn resolve_cli_credential(store: &SecretsStore, id: &str) -> Option<ResolvedProvider> {
    if !cli_opt_in(store, id) {
        return None;
    }
    let cred = cli_credential(id)?;
    let base_url = openai_oauth_base_url(id, cred.auth_mode, provider_base_url(store, id)?);
    Some(ResolvedProvider {
        provider: id.to_string(),
        base_url,
        api_key: Some(cred.token),
        source: SOURCE_CLI.to_string(),
        auth_mode: cred.auth_mode.to_string(),
        account_id: cred.account_id,
    })
}

/// Status of every known provider, for the Settings UI. Never returns keys.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_status(store: State<'_, Arc<SecretsStore>>) -> Vec<ProviderStatus> {
    PROVIDERS
        .iter()
        .map(|info| {
            // Deliberately not `resolve_inner`: the toggle needs to keep
            // showing what the provider would resolve to while it's off, so
            // flipping it back on doesn't come with a surprise.
            let resolved = resolve_ignoring_enabled(&store, info.id);
            let env_var = resolved.as_ref().and_then(|r| {
                (r.source == SOURCE_ENV)
                    .then(|| {
                        info.env_vars
                            .iter()
                            .find(|v| std::env::var(v).is_ok_and(|s| !s.trim().is_empty()))
                            .map(|v| (*v).to_string())
                    })
                    .flatten()
            });
            ProviderStatus {
                id: info.id.to_string(),
                label: info.label.to_string(),
                base_url: resolved
                    .as_ref()
                    .map_or_else(|| info.default_base_url.to_string(), |r| r.base_url.clone()),
                configured: resolved.is_some(),
                source: resolved.map(|r| r.source),
                keyless: info.keyless,
                env_var,
                enabled: !provider_disabled(&store, info.id),
            }
        })
        .collect()
}

/// Resolve the credential set the model server should run with.
///
/// Returned to the Rust sidecar launcher only — see `server.rs`.
pub fn resolve_all(store: &SecretsStore) -> Vec<ResolvedProvider> {
    PROVIDERS
        .iter()
        .filter_map(|info| resolve_inner(store, info.id))
        .collect()
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Save a provider credential. An empty `api_key` clears it, which lets the
/// next source in the precedence chain take over.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_save(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider id is required".to_string());
    }

    match api_key.as_deref().map(str::trim) {
        Some("") | None => {
            let _ = store.inner.delete(&api_key_slot(&provider));
        }
        Some(key) => store
            .inner
            .set(&api_key_slot(&provider), key)
            .map_err(|e| e.to_string())?,
    }

    match base_url.as_deref().map(str::trim) {
        Some("") | None => {
            let _ = store.inner.delete_plain(&base_url_slot(&provider));
        }
        Some(url) => {
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("base URL must start with http:// or https://".to_string());
            }
            store
                .inner
                .set_plain(&base_url_slot(&provider), url.trim_end_matches('/'))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// The delete action itself, pulled out of `providers_delete` so it's callable
/// with a plain `&SecretsStore` — both from the command and from tests that
/// have no `tauri::State` to construct.
fn delete_provider(store: &SecretsStore, provider: &str) {
    let _ = store.inner.delete(&api_key_slot(provider));
    let _ = store.inner.delete_plain(&base_url_slot(provider));
    let _ = store.inner.delete_plain(&cli_opt_in_slot(provider));
    // Deleting must reset the provider to its true default (on), not leave
    // it stuck off with nothing left to show that in the UI.
    let _ = store.inner.delete_plain(&provider_off_slot(provider));
}

/// Forget everything stored for a provider, including its CLI opt-in and its
/// off switch.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_delete(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
) -> Result<(), String> {
    delete_provider(&store, &provider);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reusing an existing CLI login / "Connect account"
// ---------------------------------------------------------------------------

/// The two CLI logins `SideX` can connect as accounts, paired with the name
/// their own CLI uses. `providers_detect_cli` (legacy shape) and
/// `accounts_list` (the Connect account flow) both iterate this list so the
/// two surfaces can never disagree about which providers exist.
const ACCOUNT_PROVIDERS: &[(&str, &str)] = &[("anthropic", "Claude Code"), ("openai", "Codex")];

fn cli_opt_in(store: &SecretsStore, provider: &str) -> bool {
    matches!(
        store
            .inner
            .get_plain(&cli_opt_in_slot(provider))
            .ok()
            .flatten()
            .as_deref(),
        Some("1")
    )
}

/// Flip the per-provider opt-in. Shared by `providers_set_cli_auth` (kept
/// for the existing call site) and `accounts_connect` / `accounts_disconnect`
/// (the account-flow names for the same action).
fn set_cli_opt_in(store: &SecretsStore, provider: &str, enabled: bool) -> Result<(), String> {
    if enabled {
        store
            .inner
            .set_plain(&cli_opt_in_slot(provider), "1")
            .map_err(|e| e.to_string())
    } else {
        let _ = store.inner.delete_plain(&cli_opt_in_slot(provider));
        Ok(())
    }
}

/// Turn "reuse my Claude Code / Codex login" on or off for a provider.
///
/// Off by default. While off, nothing under `~/.claude` or `~/.codex` is read.
/// Other call sites already invoke this by name, so it stays as a thin
/// delegate to `set_cli_opt_in` rather than being replaced outright.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_set_cli_auth(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
    enabled: bool,
) -> Result<(), String> {
    set_cli_opt_in(&store, &provider, enabled)
}

/// True when the user has explicitly switched a provider off. Distinct from
/// `configured`: a keyless provider is always "configured" (it needs no
/// credential), so without this separate flag there would be no way to stop
/// `SideX` from treating it as available.
fn provider_disabled(store: &SecretsStore, provider: &str) -> bool {
    matches!(
        store
            .inner
            .get_plain(&provider_off_slot(provider))
            .ok()
            .flatten()
            .as_deref(),
        Some("1")
    )
}

/// Flip the per-provider off switch. Note the polarity is inverted from the
/// slot itself: `enabled: true` clears the "off" row (the default state —
/// nothing stored means on), `enabled: false` writes it.
fn set_provider_enabled(store: &SecretsStore, provider: &str, enabled: bool) -> Result<(), String> {
    if enabled {
        let _ = store.inner.delete_plain(&provider_off_slot(provider));
        Ok(())
    } else {
        store
            .inner
            .set_plain(&provider_off_slot(provider), "1")
            .map_err(|e| e.to_string())
    }
}

/// Turn a provider on or off.
///
/// This is the fix for keyless local providers (Ollama, LM Studio, …) always
/// showing "configured": they need no credential, so before this switch
/// existed there was nothing to clear that would ever make the toggle stick
/// in the off position. `resolve_inner` checks this before every other
/// credential source, so a disabled provider is invisible to `server_env`
/// regardless of what credentials it has.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_set_enabled(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
    enabled: bool,
) -> Result<(), String> {
    set_provider_enabled(&store, &provider, enabled)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLogin {
    /// Provider this login can serve (`anthropic` or `openai`).
    pub provider: String,
    /// Which CLI it belongs to, for display ("Claude Code", "Codex").
    pub tool: String,
    /// True only when a credential was found *and* is usable (not expired).
    pub available: bool,
    /// True when the user has opted into using it.
    pub enabled: bool,
    /// Where it was found, for the UI to explain itself.
    pub location: String,
    /// `api_key` or `oauth`. An OAuth login is a subscription credential.
    pub auth_mode: String,
    /// True when this is a subscription token rather than a billed API key,
    /// so the UI can warn that the provider's terms may not cover its use in
    /// another client.
    pub subscription: bool,
}

/// Report which CLI logins exist and can actually be used.
///
/// The credential itself is read here only to confirm it is usable; it is
/// never returned to the webview — `DetectedLogin` has no field that could
/// hold it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn providers_detect_cli(store: State<'_, Arc<SecretsStore>>) -> Vec<CliLogin> {
    ACCOUNT_PROVIDERS
        .iter()
        .map(|&(provider, tool)| {
            let detected = detect_login(provider);
            CliLogin {
                provider: provider.to_string(),
                tool: tool.to_string(),
                available: detected.found && !detected.expired,
                enabled: cli_opt_in(&store, provider),
                location: detected.location,
                subscription: detected.credential_kind == AUTH_OAUTH,
                auth_mode: detected.credential_kind.to_string(),
            }
        })
        .collect()
}

/// One CLI login as a connectable account, for the Settings → Accounts UI.
/// Same detection as `providers_detect_cli`, reshaped as an account (with
/// expiry and, where cheaply readable from the credential file itself,
/// subscription tier / account email) rather than a raw login flag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    /// Provider this account authenticates (`anthropic` or `openai`).
    pub provider: String,
    /// CLI/product name for display ("Claude Code", "Codex").
    pub display_name: String,
    /// True only when a login was found *and* is not expired.
    pub available: bool,
    /// True when a login was found but its token has since expired — surfaced
    /// so the UI can ask the user to sign in again instead of the connection
    /// just failing silently the next time it's used.
    pub expired: bool,
    /// True when the user has opted into using this login for requests.
    pub connected: bool,
    /// Where the credential was found, for the UI to explain itself.
    pub location: String,
    /// `api_key` or `oauth`.
    pub credential_kind: String,
    /// Subscription/plan label (e.g. Claude's `subscriptionType`, Codex's
    /// `ChatGPT` plan), when the credential file carries one. `None` when it
    /// doesn't, or when nothing was found.
    pub subscription_tier: Option<String>,
    /// Account email, when the credential file carries one. `None` when it
    /// doesn't, or when nothing was found.
    pub account_email: Option<String>,
}

/// List Claude Code / Codex as connectable accounts: whether a usable login
/// exists on this machine, whether the user has opted into it, and enough
/// detail to explain both — without ever reading out the credential itself.
///
/// This is the "Connect account" entry point. It does not perform any OAuth
/// handshake; `accounts_connect` only turns on reuse of a login the official
/// CLI already created.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn accounts_list(store: State<'_, Arc<SecretsStore>>) -> Vec<AccountInfo> {
    ACCOUNT_PROVIDERS
        .iter()
        .map(|&(provider, display_name)| {
            let detected = detect_login(provider);
            AccountInfo {
                provider: provider.to_string(),
                display_name: display_name.to_string(),
                available: detected.found && !detected.expired,
                expired: detected.found && detected.expired,
                connected: cli_opt_in(&store, provider),
                location: detected.location,
                credential_kind: detected.credential_kind.to_string(),
                subscription_tier: detected.subscription_tier,
                account_email: detected.account_email,
            }
        })
        .collect()
}

/// Connect an account: the one-click counterpart to `accounts_list`.
///
/// Refuses to turn the opt-in on when there is nothing usable to connect to,
/// so a click either connects or explains why it can't — it never leaves the
/// toggle on with an expired or missing login behind it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn accounts_connect(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
) -> Result<(), String> {
    let detected = detect_login(&provider);
    if detected.expired {
        return Err(format!(
            "The {provider} login on this machine has expired. Sign in again with that CLI, then try connecting again."
        ));
    }
    if !detected.found {
        return Err(format!(
            "No usable {provider} CLI login was found on this machine."
        ));
    }
    set_cli_opt_in(&store, &provider, true)
}

/// Disconnect an account: clear the opt-in set by `accounts_connect`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn accounts_disconnect(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
) -> Result<(), String> {
    set_cli_opt_in(&store, &provider, false)
}

/// What's known about a CLI login without holding the credential itself.
/// Safe to reshape straight into `AccountInfo` / `CliLogin` and hand to the
/// webview, because there is deliberately no field here that could carry a
/// token — see `cli_credential` for the (separate) path that reads one.
struct DetectedLogin {
    found: bool,
    expired: bool,
    location: String,
    credential_kind: &'static str,
    subscription_tier: Option<String>,
    account_email: Option<String>,
}

impl DetectedLogin {
    fn none() -> Self {
        Self {
            found: false,
            expired: false,
            location: String::new(),
            credential_kind: AUTH_API_KEY,
            subscription_tier: None,
            account_email: None,
        }
    }
}

fn detect_login(provider: &str) -> DetectedLogin {
    match provider {
        "anthropic" => detect_claude_login(),
        "openai" => detect_codex_login(),
        _ => DetectedLogin::none(),
    }
}

fn detect_claude_login() -> DetectedLogin {
    let Some(src) = load_claude_credentials() else {
        return DetectedLogin::none();
    };
    let has_token = src
        .oauth
        .access_token
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    if !has_token {
        return DetectedLogin::none();
    }
    DetectedLogin {
        found: true,
        expired: expired_at_millis(src.oauth.expires_at),
        location: src.location,
        credential_kind: AUTH_OAUTH,
        subscription_tier: non_empty(src.oauth.subscription_type),
        account_email: claude_account_email(),
    }
}

fn detect_codex_login() -> DetectedLogin {
    let Some((auth, location)) = load_codex_auth() else {
        return DetectedLogin::none();
    };

    // A real API key wins even if OAuth tokens are also present on disk —
    // it's what `cli_credential` would pick too (see `codex_credential_from_auth`).
    if non_empty(auth.openai_api_key).is_some() {
        return DetectedLogin {
            found: true,
            // A bare API key has no expiry SideX can observe locally.
            expired: false,
            location,
            credential_kind: AUTH_API_KEY,
            subscription_tier: None,
            account_email: None,
        };
    }

    let Some(tokens) = auth.tokens else {
        return DetectedLogin::none();
    };
    let has_oauth_token = tokens
        .access_token
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    if !has_oauth_token {
        return DetectedLogin::none();
    }

    // The id_token is a JWT the ChatGPT login already issued to this
    // machine; Codex itself decodes it (without verifying the signature)
    // purely to show account info such as `codex login status`, and this
    // does the same, for display only — resolving the actual credential
    // never depends on these claims.
    let claims = tokens
        .id_token
        .as_deref()
        .and_then(decode_jwt_claims::<IdTokenClaims>);
    DetectedLogin {
        found: true,
        // The access token is what ChatGPT authenticates. The id_token is
        // only decoded for email/plan display and often expires first —
        // treating that as "login expired" blocks Connect while the API
        // token is still valid.
        expired: codex_oauth_expired(tokens.access_token.as_deref()),
        location,
        credential_kind: AUTH_OAUTH,
        subscription_tier: claims.as_ref().and_then(IdTokenClaims::plan_type),
        account_email: claims.as_ref().and_then(IdTokenClaims::resolved_email),
    }
}

/// `dirs::home_dir()` already resolves per-OS (`$HOME`, `%USERPROFILE%`), so
/// the file-based lookups below need no `cfg` gating to work on Linux and
/// Windows — only `keychain_lookup` (macOS Keychain) is platform-specific.
fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Claude Code stores the login email in `~/.claude.json` (`oauthAccount.emailAddress`),
/// not in the Keychain token blob.
fn claude_account_email() -> Option<String> {
    let path = home()?.join(".claude.json");
    let raw = std::fs::read_to_string(path).ok()?;
    parse_claude_config_email(&raw)
}

fn parse_claude_config_email(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("oauthAccount")
        .and_then(|a| a.get("emailAddress").or_else(|| a.get("email")))
        .and_then(|e| e.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn claude_code_credential_file() -> Option<PathBuf> {
    let p = home()?.join(".claude").join(".credentials.json");
    p.exists().then_some(p)
}

fn codex_credential_path() -> Option<PathBuf> {
    Some(home()?.join(".codex").join("auth.json"))
}

#[cfg(target_os = "macos")]
fn keychain_lookup(service: &str) -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(not(target_os = "macos"))]
fn keychain_lookup(_service: &str) -> Option<String> {
    None
}

#[derive(Deserialize)]
struct ClaudeCredentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeOauth>,
}

#[derive(Deserialize)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    /// Epoch millis. Compared against `now_millis()` — see `expired_at_millis`.
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
}

/// A parsed Claude Code login plus where it came from. Kept separate from
/// `ClaudeOauth` so both `detect_claude_login` (metadata only) and
/// `claude_credential_from_oauth` (the actual resolve path) share one read
/// of the file/Keychain instead of duplicating that lookup.
struct ClaudeLoginSource {
    oauth: ClaudeOauth,
    location: String,
}

/// Read a Claude Code login from `~/.claude/.credentials.json` first, then
/// the macOS Keychain — same precedence `cli_credential` always used.
fn load_claude_credentials() -> Option<ClaudeLoginSource> {
    if let Some(path) = claude_code_credential_file() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<ClaudeCredentials>(&raw) {
                if let Some(oauth) = parsed.claude_ai_oauth {
                    return Some(ClaudeLoginSource {
                        oauth,
                        location: path.display().to_string(),
                    });
                }
            }
        }
    }
    let raw = keychain_lookup("Claude Code-credentials")?;
    let oauth = serde_json::from_str::<ClaudeCredentials>(&raw)
        .ok()?
        .claude_ai_oauth?;
    Some(ClaudeLoginSource {
        oauth,
        location: "macOS Keychain (Claude Code-credentials)".to_string(),
    })
}

#[derive(Deserialize)]
struct CodexAuth {
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexTokens>,
}

#[derive(Deserialize)]
struct CodexTokens {
    access_token: Option<String>,
    /// A JWT; see `decode_jwt_claims` and `IdTokenClaims`. Only present for
    /// an OAuth (`ChatGPT`) login, never for a plain API key.
    id_token: Option<String>,
    /// ChatGPT account UUID. Required by the Codex Responses host.
    account_id: Option<String>,
}

/// Read `~/.codex/auth.json`, whichever credential shape it holds.
fn load_codex_auth() -> Option<(CodexAuth, String)> {
    let path = codex_credential_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed = serde_json::from_str(&raw).ok()?;
    Some((parsed, path.display().to_string()))
}

/// Claims read out of a Codex `id_token`, unverified — see `decode_jwt_claims`.
/// Deliberately not `Serialize`: a `#[tauri::command]` can't return this by
/// accident, which is the same compile-time guardrail `CliCredential` gets
/// below from not deriving it either.
#[derive(Deserialize)]
struct IdTokenClaims {
    email: Option<String>,
    /// Unix seconds, per the JWT spec — converted to millis in `jwt_exp_has_passed`.
    exp: Option<i64>,
    #[serde(rename = "https://api.openai.com/profile")]
    profile: Option<ProfileClaims>,
    #[serde(rename = "https://api.openai.com/auth")]
    auth: Option<AuthClaims>,
}

#[derive(Deserialize)]
struct ProfileClaims {
    email: Option<String>,
}

#[derive(Deserialize)]
struct AuthClaims {
    chatgpt_plan_type: Option<String>,
}

impl IdTokenClaims {
    /// The top-level `email` claim wins when present; some ID tokens only
    /// carry it under the namespaced profile claim instead.
    fn resolved_email(&self) -> Option<String> {
        non_empty(self.email.clone()).or_else(|| {
            self.profile
                .as_ref()
                .and_then(|p| non_empty(p.email.clone()))
        })
    }

    fn plan_type(&self) -> Option<String> {
        self.auth
            .as_ref()
            .and_then(|a| non_empty(a.chatgpt_plan_type.clone()))
    }
}

/// Best-effort, unverified read of a JWT's payload claims.
///
/// The token already came from a login the user completed in the official
/// CLI; this reads the same display claims that CLI reads for itself (e.g.
/// `codex login status`) and never checks the signature, because it is never
/// used to decide whether a request is authorized — only the token string
/// itself (read separately, in `cli_credential`) is ever sent to a provider.
fn decode_jwt_claims<T: serde::de::DeserializeOwned>(token: &str) -> Option<T> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Current time as epoch millis, for comparing against `expiresAt` fields.
/// A clock that can't be read (before the Unix epoch) falls back to `0`,
/// which — like a missing timestamp — reads as "not expired": a detection
/// bug should never silently disable a login that still works.
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// True when `ts` (epoch millis) is in the past. `None` — nothing to compare
/// — is never expired, for the same fail-open reason as `now_millis`.
fn expired_at_millis(ts: Option<i64>) -> bool {
    ts.is_some_and(|t| t <= now_millis())
}

/// JWT `exp` claims are Unix *seconds*; this is the one place that gets
/// converted to the millis the rest of this file compares in.
fn jwt_exp_has_passed(exp_seconds: i64) -> bool {
    expired_at_millis(exp_seconds.checked_mul(1000))
}

/// True when the Codex *access* token's JWT `exp` has passed. A token that
/// is not a JWT, has no `exp`, or fails to decode is treated as not expired
/// — same fail-open reasoning as `now_millis`. The id_token is never used
/// here: it is a display JWT and is not what `/responses` authenticates.
fn codex_oauth_expired(access_token: Option<&str>) -> bool {
    access_token
        .and_then(decode_jwt_claims::<IdTokenClaims>)
        .and_then(|c| c.exp)
        .is_some_and(jwt_exp_has_passed)
}

/// A credential recovered from another tool's login, plus how it must be sent.
/// Not `Serialize` — nothing in this module can hand it to a `#[tauri::command]`
/// return value without a compile error, which is the enforcement behind
/// "never return a credential value to the caller".
pub struct CliCredential {
    pub token: String,
    pub auth_mode: &'static str,
    pub account_id: Option<String>,
}

/// A ChatGPT login is not an OpenAI platform key. Keep a user-supplied
/// base URL (Azure, a proxy, …) but retarget the stock `api.openai.com`
/// endpoint at the Codex host the official CLI uses.
fn openai_oauth_base_url(provider: &str, auth_mode: &str, base_url: String) -> String {
    if provider == "openai"
        && auth_mode == AUTH_OAUTH
        && (base_url == "https://api.openai.com/v1" || base_url == "https://api.openai.com/v1/")
    {
        OPENAI_CODEX_BASE_URL.to_string()
    } else {
        base_url
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

/// Pick the Claude Code credential to use, or `None` if it's missing or
/// expired. Pure (takes already-parsed data) so expiry handling is unit
/// testable without touching the filesystem or Keychain.
fn claude_credential_from_oauth(oauth: &ClaudeOauth) -> Option<CliCredential> {
    let token = non_empty(oauth.access_token.clone())?;
    if expired_at_millis(oauth.expires_at) {
        return None;
    }
    Some(CliCredential {
        token,
        auth_mode: AUTH_OAUTH,
        account_id: None,
    })
}

/// Pick the Codex credential to use: a real API key when present, else the
/// OAuth token from a `ChatGPT` sign-in (`OPENAI_API_KEY` is `null` in that
/// case). Pure, for the same testability reason as `claude_credential_from_oauth`.
fn codex_credential_from_auth(auth: &CodexAuth) -> Option<CliCredential> {
    if let Some(key) = non_empty(auth.openai_api_key.clone()) {
        return Some(CliCredential {
            token: key,
            auth_mode: AUTH_API_KEY,
            account_id: None,
        });
    }
    let tokens = auth.tokens.as_ref()?;
    let token = non_empty(tokens.access_token.clone())?;
    if codex_oauth_expired(tokens.access_token.as_deref()) {
        return None;
    }
    Some(CliCredential {
        token,
        auth_mode: AUTH_OAUTH,
        account_id: non_empty(tokens.account_id.clone()),
    })
}

/// Pull a usable credential out of an existing CLI login.
///
/// Only ever called after the user has opted that provider in. Both CLIs may
/// hold either a real API key or an OAuth token from an interactive login, and
/// the two are sent to the provider differently — hence `auth_mode`. An
/// expired login returns `None` here rather than the stale token, so a stale
/// connection falls through the precedence chain instead of being sent to
/// the provider and failing downstream — see `accounts_list` / `providers_detect_cli`
/// for where the expiry itself is surfaced to the user.
fn cli_credential(provider: &str) -> Option<CliCredential> {
    match provider {
        "anthropic" => claude_credential_from_oauth(&load_claude_credentials()?.oauth),
        "openai" => codex_credential_from_auth(&load_codex_auth()?.0),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Local model discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub provider: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
    /// Codex Responses host (`/models?client_version=…`) uses `models[].slug`.
    #[serde(default)]
    models: Vec<CodexModelEntry>,
}

#[derive(Deserialize)]
struct CodexModelEntry {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// One `/models` entry. Shared by both response shapes this file parses --
/// Anthropic's (`{"type":"model","id":...,"display_name":...,"created_at":...}`)
/// and the OpenAI-compatible one (`{"id":...,"object":"model",...}`) -- so it
/// only models the two fields either of them might carry. No
/// `#[serde(deny_unknown_fields)]` here: every other field either shape sends
/// (`object`, `type`, `created_at`, `owned_by`, ...) must be ignored, not
/// rejected.
#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// One model a provider offers, shaped for the Settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// Fully-qualified id, ALWAYS provider-prefixed (e.g. `anthropic/claude-opus-5`).
    pub id: String,
    /// Human label. Falls back to the bare model id when the API gives none.
    pub name: String,
}

/// The Go server derives a request's provider by splitting the model id on
/// `/` (`ProviderFromModelID`, internal/ai). Anthropic's `/models` endpoint
/// returns bare ids (`claude-opus-5`) with no prefix at all, so one of those
/// handed back unqualified would be unroutable; applied to every provider
/// uniformly since a custom OpenAI-compatible base URL could in principle
/// return pre-qualified ids too, and those must be left alone.
fn qualify_model_id(provider: &str, id: String) -> String {
    if id.contains('/') {
        id
    } else {
        format!("{provider}/{id}")
    }
}

/// Turn one raw `/models` entry into what the UI shows. Split out from
/// `providers_list_models` so the id-prefixing and name-fallback rules are
/// unit testable without a network call.
fn provider_model_from_entry(provider: &str, entry: ModelEntry) -> ProviderModel {
    let name = entry.display_name.unwrap_or_else(|| entry.id.clone());
    ProviderModel {
        id: qualify_model_id(provider, entry.id),
        name,
    }
}

/// Probe the usual loopback ports for an OpenAI-compatible `/models` endpoint.
///
/// Only 127.0.0.1 is contacted, with a short timeout, so a cold call costs
/// about a second even when nothing is listening.
#[tauri::command]
pub async fn providers_detect_local() -> Vec<LocalServer> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(600))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let probes = LOCAL_PROVIDERS.iter().filter_map(|id| {
        let info = provider_info(id)?;
        let client = client.clone();
        Some(async move {
            let url = format!("{}/models", info.default_base_url);
            let resp = client.get(&url).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            let list: ModelList = resp.json().await.ok()?;
            Some(LocalServer {
                provider: info.id.to_string(),
                label: info.label.to_string(),
                base_url: info.default_base_url.to_string(),
                models: list.data.into_iter().map(|m| m.id).collect(),
            })
        })
    });

    futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// How a provider expects an authenticated request's headers built.
///
/// Everything defaults to `Bearer` -- the OpenAI-compatible convention every
/// provider in the catalog speaks except Anthropic's native REST API -- so
/// adding a new OpenAI-compatible provider (as this file now does nine times
/// over) never touches this type or `header_style` below; only a provider
/// with its own header scheme needs a new variant/arm, in one place instead
/// of a growing if-chain at the call site.
#[derive(Debug, PartialEq, Eq)]
enum HeaderStyle {
    /// `Authorization: Bearer <key>`, omitted entirely when there is no key
    /// (a keyless loopback provider).
    Bearer,
    /// Anthropic's native scheme -- see `apply_auth_headers` for the exact
    /// headers, which must stay byte-for-byte what they were before this
    /// type existed.
    AnthropicNative,
    /// ChatGPT-subscription login against the Codex Responses host.
    OpenAICodex,
}

fn header_style(provider: &str, resolved: &ResolvedProvider) -> HeaderStyle {
    match provider {
        "anthropic" => HeaderStyle::AnthropicNative,
        "openai" if resolved.auth_mode == AUTH_OAUTH && is_codex_backend(&resolved.base_url) => {
            HeaderStyle::OpenAICodex
        }
        _ => HeaderStyle::Bearer,
    }
}

fn is_codex_backend(base_url: &str) -> bool {
    base_url.contains("chatgpt.com") || base_url.contains("backend-api/codex")
}

fn parse_codex_models_cache_version(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let version = v.get("client_version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

fn read_codex_models_cache_version() -> Option<String> {
    let path = home()?.join(".codex").join("models_cache.json");
    parse_codex_models_cache_version(&std::fs::read_to_string(path).ok()?)
}

/// Version header ChatGPT uses to gate models such as gpt-5.6-terra.
fn codex_client_version() -> String {
    if let Ok(v) = std::env::var("SIDEX_CODEX_CLIENT_VERSION") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    read_codex_models_cache_version().unwrap_or_else(|| CODEX_CLIENT_VERSION.to_string())
}

/// Apply one provider's auth headers to an outgoing `/models` request.
///
/// Split out of `providers_list_models` so the per-provider header quirks
/// live in this one match rather than an if-chain that would otherwise grow
/// with every provider added to `PROVIDERS`.
fn apply_auth_headers(
    mut req: reqwest::RequestBuilder,
    provider: &str,
    resolved: &ResolvedProvider,
) -> reqwest::RequestBuilder {
    match header_style(provider, resolved) {
        HeaderStyle::AnthropicNative => {
            // Every Anthropic REST call needs this, key or OAuth alike -- an
            // unversioned request is rejected before auth is even checked (see
            // `ANTHROPIC_VERSION`). Same pair the Go server sends.
            req = req.header("anthropic-version", ANTHROPIC_VERSION);
            if let Some(key) = &resolved.api_key {
                req = if resolved.auth_mode == AUTH_OAUTH {
                    // A Claude Code login is an OAuth token, not a console key
                    // -- Anthropic only accepts it as a bearer token, and only
                    // once this beta header opts the request into OAuth auth
                    // at all.
                    req.bearer_auth(key)
                        .header("anthropic-beta", ANTHROPIC_OAUTH_BETA)
                } else {
                    req.header("x-api-key", key)
                };
            }
            req
        }
        HeaderStyle::OpenAICodex => {
            let version = codex_client_version();
            if let Some(key) = &resolved.api_key {
                req = req.bearer_auth(key);
            }
            if let Some(account) = &resolved.account_id {
                req = req.header("ChatGPT-Account-ID", account);
            }
            req = req
                .header("OpenAI-Beta", "responses=v1")
                .header("originator", CODEX_ORIGINATOR)
                .header("version", &version)
                .header("User-Agent", format!("{CODEX_ORIGINATOR}/{version}"));
            req
        }
        HeaderStyle::Bearer => {
            // Keyless loopback providers (Ollama, ...) have no `api_key` here
            // at all, so this sends no `Authorization` header for them.
            if let Some(key) = &resolved.api_key {
                req = req.bearer_auth(key);
            }
            req
        }
    }
}

/// List the models a configured provider actually offers.
///
/// Used by Settings → Models so the catalog reflects what the user can really
/// reach, rather than a hardcoded list that drifts.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn providers_list_models(
    store: State<'_, Arc<SecretsStore>>,
    provider: String,
) -> Result<Vec<ProviderModel>, String> {
    let resolved =
        resolve_inner(&store, &provider).ok_or_else(|| format!("{provider} is not configured"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let models_url = if header_style(&provider, &resolved) == HeaderStyle::OpenAICodex {
        format!(
            "{}/models?client_version={}",
            resolved.base_url,
            codex_client_version()
        )
    } else {
        format!("{}/models", resolved.base_url)
    };
    let req = client.get(models_url);
    let req = apply_auth_headers(req, &provider, &resolved);

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{provider} returned HTTP {}", status.as_u16()));
    }
    let list: ModelList = resp.json().await.map_err(|e| e.to_string())?;
    // Preserve the API's own ordering (Anthropic returns newest first) --
    // this must not sort.
    Ok(provider_models_from_list(&provider, list))
}

fn provider_models_from_list(provider: &str, list: ModelList) -> Vec<ProviderModel> {
    let mut out: Vec<ProviderModel> = list
        .data
        .into_iter()
        .map(|m| provider_model_from_entry(provider, m))
        .collect();
    for entry in list.models {
        out.push(ProviderModel {
            id: qualify_model_id(provider, entry.slug.clone()),
            name: entry.display_name.unwrap_or(entry.slug),
        });
    }
    out
}

/// Env pairs handed to the model server process at spawn.
///
/// Keys travel through the process environment of a loopback-only child, which
/// keeps them out of the webview and out of any config file on disk.
pub fn server_env(store: &SecretsStore) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for r in resolve_all(store) {
        let up = r.provider.to_uppercase();
        if let Some(key) = r.api_key {
            env.insert(format!("SIDEX_PROVIDER_{up}_KEY"), key);
        }
        env.insert(format!("SIDEX_PROVIDER_{up}_BASE_URL"), r.base_url);
        env.insert(format!("SIDEX_PROVIDER_{up}_AUTH"), r.auth_mode);
        if let Some(account) = r.account_id {
            env.insert(format!("SIDEX_PROVIDER_{up}_ACCOUNT_ID"), account);
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<_> = PROVIDERS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate provider id in catalog");
    }

    #[test]
    fn local_providers_are_keyless_and_loopback() {
        for id in LOCAL_PROVIDERS {
            let info = provider_info(id).expect("local provider missing from catalog");
            assert!(info.keyless, "{id} should not require a key");
            assert!(
                info.default_base_url.starts_with("http://127.0.0.1:"),
                "{id} must probe loopback only, got {}",
                info.default_base_url
            );
        }
    }

    #[test]
    fn remote_providers_use_tls() {
        // `openai-compatible` is the one deliberate exception -- its
        // `default_base_url` is empty by design (there is no sensible
        // default for a user-supplied endpoint), so it's excluded here and
        // covered on its own by `generic_openai_compatible_has_no_default`.
        for info in PROVIDERS
            .iter()
            .filter(|p| !p.keyless && !p.default_base_url.is_empty())
        {
            assert!(
                info.default_base_url.starts_with("https://"),
                "{} must default to https, got {}",
                info.id,
                info.default_base_url
            );
        }
    }

    #[test]
    fn generic_openai_compatible_has_no_default() {
        let info = provider_info("openai-compatible").expect("must be in the catalog");
        assert!(
            info.default_base_url.is_empty(),
            "openai-compatible must carry no default -- there is no sensible one"
        );
        assert!(
            !info.keyless,
            "a user-supplied remote endpoint must require a key"
        );
    }

    #[test]
    fn newly_added_remote_providers_are_present_and_keyed() {
        for id in [
            "fireworks",
            "deepinfra",
            "perplexity",
            "hyperbolic",
            "nebius",
            "sambanova",
            "novita",
            "anyscale",
        ] {
            let info = provider_info(id).unwrap_or_else(|| panic!("{id} missing from catalog"));
            assert!(!info.keyless, "{id} is a hosted API and must require a key");
            assert!(
                !info.env_vars.is_empty(),
                "{id} must check at least one env var"
            );
            assert!(
                !info.console_url.is_empty(),
                "{id} must link to where a key is issued"
            );
        }
    }

    #[test]
    fn slots_are_namespaced_per_provider() {
        assert_eq!(api_key_slot("openai"), "sidex.apikey.openai");
        assert_eq!(base_url_slot("openai"), "sidex.baseurl.openai");
        assert_eq!(cli_opt_in_slot("openai"), "sidex.cli-auth.openai");
        assert_eq!(provider_off_slot("openai"), "sidex.provider-off.openai");
    }

    // -- explicit per-provider off switch --------------------------------

    /// A `SecretsStore` backed by its own throwaway `SQLite` file, with the OS
    /// keyring bypassed.
    ///
    /// The keyring is keyed by name alone, so it is shared by every store in
    /// the process — a unique database path alone would isolate nothing, tests
    /// would race each other, and a `cargo test` run could leave a provider
    /// switched off in the developer's real install.
    fn test_store() -> SecretsStore {
        let path =
            std::env::temp_dir().join(format!("sidex-providers-test-{}.db", uuid::Uuid::new_v4()));
        SecretsStore {
            inner: sidex_auth::SecretStorage::open_without_keyring(path)
                .expect("open test secret store"),
        }
    }

    /// The four disable behaviours share one test on purpose.
    ///
    /// `SecretStorage` reads the OS keyring before its SQLite fallback, and the
    /// keyring is keyed by name alone — so a per-test database file does NOT
    /// isolate anything. Run as separate `#[test]`s these race each other on
    /// the real keychain, and one test's "disabled" state breaks another's
    /// sanity check. Kept sequential, and cleaned up, so a `cargo test` run
    /// cannot leave a provider switched off in the developer's own install.
    #[test]
    fn disable_switch_governs_resolution_env_and_reset() {
        let store = test_store();
        let provider = "ollama";
        // Guard against debris from an interrupted earlier run.
        delete_provider(&store, provider);

        assert!(
            resolve_inner(&store, provider).is_some(),
            "sanity: a keyless provider resolves before being disabled"
        );
        assert!(
            server_env(&store)
                .keys()
                .any(|k| k.starts_with("SIDEX_PROVIDER_OLLAMA_")),
            "sanity: a keyless provider reaches server_env before being disabled"
        );

        set_provider_enabled(&store, provider, false).unwrap();
        assert!(
            resolve_inner(&store, provider).is_none(),
            "a disabled provider must not resolve just because it's keyless"
        );
        assert!(
            !server_env(&store)
                .keys()
                .any(|k| k.starts_with("SIDEX_PROVIDER_OLLAMA_")),
            "a disabled provider must never reach the server env the Go side reads"
        );

        set_provider_enabled(&store, provider, true).unwrap();
        assert!(
            resolve_inner(&store, provider).is_some(),
            "clearing the off switch must restore the provider's normal resolution"
        );

        set_provider_enabled(&store, provider, false).unwrap();
        assert!(provider_disabled(&store, provider));
        delete_provider(&store, provider);
        assert!(
            !provider_disabled(&store, provider),
            "deleting a provider must reset it to enabled, not leave it stuck off"
        );
    }

    #[test]
    fn cli_connect_and_api_key_toggle_are_independent() {
        let store = test_store();
        let provider = "anthropic";
        delete_provider(&store, provider);

        set_provider_enabled(&store, provider, false).unwrap();
        set_cli_opt_in(&store, provider, true).unwrap();
        assert!(
            provider_disabled(&store, provider),
            "connecting Claude Code must not flip the Anthropic API key row on"
        );
        assert!(cli_opt_in(&store, provider));

        set_provider_enabled(&store, provider, true).unwrap();
        assert!(
            cli_opt_in(&store, provider),
            "turning the API key row on must not disconnect Claude Code"
        );

        set_provider_enabled(&store, provider, false).unwrap();
        assert!(
            cli_opt_in(&store, provider),
            "turning the API key row off must not disconnect Claude Code"
        );

        set_cli_opt_in(&store, provider, false).unwrap();
        assert!(
            provider_disabled(&store, provider),
            "disconnecting Claude Code must not change the API key row"
        );

        delete_provider(&store, provider);
    }

    #[test]
    fn api_keys_status_does_not_treat_a_cli_login_as_a_configured_key() {
        let store = test_store();
        let provider = "anthropic";
        delete_provider(&store, provider);
        set_cli_opt_in(&store, provider, true).unwrap();

        let direct = resolve_ignoring_enabled(&store, provider);
        assert!(
            direct.as_ref().map(|r| r.source.as_str()) != Some(SOURCE_CLI),
            "the API Keys row must not report a Claude Code login as a typed key"
        );

        delete_provider(&store, provider);
    }

    // -- generic `openai-compatible` connector ---------------------------

    #[test]
    fn generic_openai_compatible_only_resolves_once_a_base_url_is_supplied() {
        let store = test_store();
        let provider = "openai-compatible";
        delete_provider(&store, provider);

        assert!(
            resolve_inner(&store, provider).is_none(),
            "must not resolve with nothing supplied -- it has no default base URL to fall back to"
        );

        // A key with no base URL still isn't enough: there is nothing to
        // fall back to for the URL half.
        store.inner.set(&api_key_slot(provider), "sk-test").unwrap();
        assert!(
            resolve_inner(&store, provider).is_none(),
            "a key alone must not resolve without a base URL"
        );

        store
            .inner
            .set_plain(&base_url_slot(provider), "https://example.com/v1")
            .unwrap();
        assert!(
            resolve_inner(&store, provider).is_some(),
            "must resolve once both a base URL and a key are supplied"
        );

        delete_provider(&store, provider);
    }

    // -- per-provider header strategy ------------------------------------

    fn dummy_resolved(provider: &str, auth: &str, base: &str) -> ResolvedProvider {
        ResolvedProvider {
            provider: provider.to_string(),
            base_url: base.to_string(),
            api_key: Some("k".to_string()),
            source: SOURCE_SETTINGS.to_string(),
            auth_mode: auth.to_string(),
            account_id: None,
        }
    }

    #[test]
    fn header_style_is_anthropic_native_only_for_anthropic() {
        assert_eq!(
            header_style(
                "anthropic",
                &dummy_resolved("anthropic", AUTH_API_KEY, "https://api.anthropic.com/v1")
            ),
            HeaderStyle::AnthropicNative
        );
        for id in PROVIDERS
            .iter()
            .map(|p| p.id)
            .filter(|&id| id != "anthropic")
        {
            assert_eq!(
                header_style(id, &dummy_resolved(id, AUTH_API_KEY, "https://example.com/v1")),
                HeaderStyle::Bearer,
                "{id} must use the default Bearer header style, not Anthropic's"
            );
        }
    }

    #[test]
    fn openai_oauth_retargets_stock_api_host_to_codex() {
        assert_eq!(
            openai_oauth_base_url("openai", AUTH_OAUTH, "https://api.openai.com/v1".to_string()),
            OPENAI_CODEX_BASE_URL
        );
        assert_eq!(
            openai_oauth_base_url(
                "openai",
                AUTH_API_KEY,
                "https://api.openai.com/v1".to_string()
            ),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            openai_oauth_base_url(
                "openai",
                AUTH_OAUTH,
                "https://my-proxy.example/v1".to_string()
            ),
            "https://my-proxy.example/v1"
        );
    }

    #[test]
    fn parse_codex_models_cache_version_reads_client_version() {
        assert_eq!(
            parse_codex_models_cache_version(r#"{"client_version":"0.146.0","models":[]}"#).as_deref(),
            Some("0.146.0")
        );
        assert_eq!(parse_codex_models_cache_version("{}"), None);
    }

    #[test]
    fn header_style_uses_codex_for_chatgpt_oauth() {
        let resolved = ResolvedProvider {
            provider: "openai".to_string(),
            base_url: OPENAI_CODEX_BASE_URL.to_string(),
            api_key: Some("tok".to_string()),
            source: SOURCE_CLI.to_string(),
            auth_mode: AUTH_OAUTH.to_string(),
            account_id: Some("acct".to_string()),
        };
        assert_eq!(header_style("openai", &resolved), HeaderStyle::OpenAICodex);
    }

    // -- expiry detection ----------------------------------------------

    #[test]
    fn expired_at_millis_treats_past_as_expired_and_future_and_none_as_valid() {
        let now = now_millis();
        assert!(expired_at_millis(Some(now - 1)));
        assert!(!expired_at_millis(Some(now + 1_000_000)));
        assert!(!expired_at_millis(None));
    }

    #[test]
    fn claude_expired_oauth_token_is_not_returned_as_a_credential() {
        let oauth = ClaudeOauth {
            access_token: Some("tok".to_string()),
            expires_at: Some(now_millis() - 1_000),
            subscription_type: Some("pro".to_string()),
        };
        assert!(
            claude_credential_from_oauth(&oauth).is_none(),
            "an expired claudeAiOauth.expiresAt must not resolve to a usable credential"
        );
    }

    #[test]
    fn claude_future_expiry_still_resolves() {
        let oauth = ClaudeOauth {
            access_token: Some("tok".to_string()),
            expires_at: Some(now_millis() + 1_000_000),
            subscription_type: None,
        };
        let cred = claude_credential_from_oauth(&oauth).expect("should still be usable");
        assert_eq!(cred.token, "tok");
        assert_eq!(cred.auth_mode, AUTH_OAUTH);
    }

    #[test]
    fn claude_missing_expires_at_is_treated_as_not_expired() {
        let oauth = ClaudeOauth {
            access_token: Some("tok".to_string()),
            expires_at: None,
            subscription_type: None,
        };
        assert!(claude_credential_from_oauth(&oauth).is_some());
    }

    fn jwt_with_exp(exp_seconds: i64) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"exp":{exp_seconds}}}"#));
        format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig")
    }

    #[test]
    fn codex_expired_oauth_token_is_not_returned_as_a_credential() {
        let auth = CodexAuth {
            openai_api_key: None,
            tokens: Some(CodexTokens {
                access_token: Some(jwt_with_exp(now_millis() / 1000 - 60)),
                id_token: Some("id_ignored".to_string()),
                account_id: None,
            }),
        };
        assert!(codex_credential_from_auth(&auth).is_none());
    }

    #[test]
    fn codex_expired_id_token_does_not_kill_a_live_access_token() {
        let auth = CodexAuth {
            openai_api_key: None,
            tokens: Some(CodexTokens {
                access_token: Some("at_live".to_string()),
                id_token: Some(jwt_with_exp(now_millis() / 1000 - 60)),
                account_id: Some("acct".to_string()),
            }),
        };
        let cred = codex_credential_from_auth(&auth).expect("access token still usable");
        assert_eq!(cred.token, "at_live");
        assert_eq!(cred.account_id.as_deref(), Some("acct"));
    }

    // -- Codex null-API-key fallback to the OAuth token ------------------

    #[test]
    fn codex_null_api_key_falls_back_to_oauth_access_token() {
        let auth: CodexAuth = serde_json::from_str(
            r#"{"OPENAI_API_KEY": null, "tokens": {"access_token": "at_123", "id_token": null}}"#,
        )
        .unwrap();
        let cred = codex_credential_from_auth(&auth).expect("should fall back to oauth token");
        assert_eq!(cred.token, "at_123");
        assert_eq!(cred.auth_mode, AUTH_OAUTH);
    }

    #[test]
    fn codex_prefers_a_real_api_key_when_present() {
        let auth: CodexAuth = serde_json::from_str(
            r#"{"OPENAI_API_KEY": "sk-abc", "tokens": {"access_token": "at_ignored", "id_token": null}}"#,
        )
        .unwrap();
        let cred = codex_credential_from_auth(&auth).expect("api key should resolve");
        assert_eq!(cred.token, "sk-abc");
        assert_eq!(cred.auth_mode, AUTH_API_KEY);
    }

    #[test]
    fn codex_missing_everything_resolves_to_no_credential() {
        let auth: CodexAuth =
            serde_json::from_str(r#"{"OPENAI_API_KEY": null, "tokens": null}"#).unwrap();
        assert!(codex_credential_from_auth(&auth).is_none());
    }

    // -- JWT claim decoding (display only, never used to authorize) -----

    #[test]
    fn decode_jwt_claims_reads_unverified_payload() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"user@example.com","exp":9999999999}"#);
        let token = format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig");
        let claims: IdTokenClaims =
            decode_jwt_claims(&token).expect("payload should decode even with a bogus signature");
        assert_eq!(claims.email.as_deref(), Some("user@example.com"));
        assert_eq!(claims.exp, Some(9_999_999_999));
    }

    #[test]
    fn id_token_email_prefers_top_level_then_falls_back_to_profile_claim() {
        let claims: IdTokenClaims = serde_json::from_str(
            r#"{"email":"top@example.com","https://api.openai.com/profile":{"email":"profile@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(claims.resolved_email().as_deref(), Some("top@example.com"));

        let claims: IdTokenClaims = serde_json::from_str(
            r#"{"https://api.openai.com/profile":{"email":"profile@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            claims.resolved_email().as_deref(),
            Some("profile@example.com")
        );

        let claims: IdTokenClaims = serde_json::from_str("{}").unwrap();
        assert_eq!(claims.resolved_email(), None);
    }

    // -- no function returns a raw token ---------------------------------

    #[test]
    fn parse_claude_config_email_reads_oauth_account() {
        let email = parse_claude_config_email(
            r#"{"oauthAccount":{"emailAddress":"max@example.com","organizationUuid":"x"}}"#,
        );
        assert_eq!(email.as_deref(), Some("max@example.com"));
        assert_eq!(parse_claude_config_email("{}"), None);
    }

    #[test]
    fn account_info_json_never_carries_a_credential_field() {
        let account = AccountInfo {
            provider: "anthropic".to_string(),
            display_name: "Claude Code".to_string(),
            available: true,
            expired: false,
            connected: true,
            location: "~/.claude/.credentials.json".to_string(),
            credential_kind: AUTH_OAUTH.to_string(),
            subscription_tier: Some("pro".to_string()),
            account_email: Some("someone@example.com".to_string()),
        };
        let json = serde_json::to_value(&account).unwrap();
        let keys = json.as_object().unwrap();
        for forbidden in [
            "token",
            "accessToken",
            "apiKey",
            "api_key",
            "credential",
            "secret",
        ] {
            assert!(
                !keys.contains_key(forbidden),
                "AccountInfo must never serialize a {forbidden} field"
            );
        }
    }

    #[test]
    fn cli_login_json_never_carries_a_credential_field() {
        let login = CliLogin {
            provider: "openai".to_string(),
            tool: "Codex".to_string(),
            available: true,
            enabled: true,
            location: "~/.codex/auth.json".to_string(),
            auth_mode: AUTH_OAUTH.to_string(),
            subscription: true,
        };
        let json = serde_json::to_value(&login).unwrap();
        let keys = json.as_object().unwrap();
        for forbidden in [
            "token",
            "accessToken",
            "apiKey",
            "api_key",
            "credential",
            "secret",
        ] {
            assert!(
                !keys.contains_key(forbidden),
                "CliLogin must never serialize a {forbidden} field"
            );
        }
    }

    #[test]
    fn detect_login_for_unknown_provider_is_never_found() {
        let detected = detect_login("does-not-exist");
        assert!(!detected.found);
        assert!(!detected.expired);
        assert!(detected.location.is_empty());
    }

    // -- providers_list_models: id prefixing / name fallback -------------

    #[test]
    fn qualify_model_id_prefixes_a_bare_id_only() {
        assert_eq!(
            qualify_model_id("anthropic", "claude-opus-5".to_string()),
            "anthropic/claude-opus-5"
        );
    }

    #[test]
    fn qualify_model_id_leaves_an_already_qualified_id_untouched() {
        // A custom OpenAI-compatible base URL (e.g. an OpenRouter-style
        // aggregator) can plausibly hand back ids that already carry a
        // provider prefix; those must not become doubly-prefixed.
        assert_eq!(
            qualify_model_id("openrouter", "anthropic/claude-opus-5".to_string()),
            "anthropic/claude-opus-5"
        );
    }

    #[test]
    fn provider_model_name_falls_back_to_the_id_when_no_display_name() {
        // OpenAI-compatible shape: no `display_name` field at all.
        let entry: ModelEntry =
            serde_json::from_str(r#"{"id":"gpt-4o","object":"model","owned_by":"openai"}"#)
                .unwrap();
        let model = provider_model_from_entry("openai", entry);
        assert_eq!(model.id, "openai/gpt-4o");
        assert_eq!(model.name, "gpt-4o");
    }

    #[test]
    fn provider_model_uses_display_name_when_present() {
        // Anthropic shape, with fields (`type`, `created_at`) ModelEntry
        // doesn't model.
        let entry: ModelEntry = serde_json::from_str(
            r#"{"type":"model","id":"claude-opus-5","display_name":"Claude Opus 5","created_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let model = provider_model_from_entry("anthropic", entry);
        assert_eq!(model.id, "anthropic/claude-opus-5");
        assert_eq!(model.name, "Claude Opus 5");
    }

    #[test]
    fn codex_models_envelope_is_parsed() {
        let list: ModelList = serde_json::from_str(
            r#"{"models":[{"slug":"gpt-5.4-mini","display_name":"GPT-5.4 mini"}]}"#,
        )
        .unwrap();
        let models = provider_models_from_list("openai", list);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "openai/gpt-5.4-mini");
        assert_eq!(models[0].name, "GPT-5.4 mini");
    }

    #[test]
    fn codex_auth_json_carries_account_id_on_oauth() {
        let auth: CodexAuth = serde_json::from_str(
            r#"{"OPENAI_API_KEY":null,"tokens":{"access_token":"at","id_token":null,"account_id":"acct-1"}}"#,
        )
        .unwrap();
        let cred = codex_credential_from_auth(&auth).expect("oauth");
        assert_eq!(cred.account_id.as_deref(), Some("acct-1"));
        assert_eq!(cred.auth_mode, AUTH_OAUTH);
    }

    #[test]
    fn model_list_deserialize_tolerates_unknown_fields_in_both_shapes() {
        let openai_shape: ModelList = serde_json::from_str(
            r#"{"data":[{"id":"gpt-4o","object":"model","owned_by":"openai","created":123}]}"#,
        )
        .unwrap();
        assert_eq!(openai_shape.data.len(), 1);
        assert_eq!(openai_shape.data[0].id, "gpt-4o");
        assert!(openai_shape.data[0].display_name.is_none());

        let anthropic_shape: ModelList = serde_json::from_str(
            r#"{"data":[{"type":"model","id":"claude-opus-5","display_name":"Claude Opus 5","created_at":"2026-01-01T00:00:00Z"}],"has_more":false}"#,
        )
        .unwrap();
        assert_eq!(anthropic_shape.data.len(), 1);
        assert_eq!(
            anthropic_shape.data[0].display_name.as_deref(),
            Some("Claude Opus 5")
        );
    }
}
