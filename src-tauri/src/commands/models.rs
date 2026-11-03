// This module is intentionally empty.
//
// It previously held two generations of dead weight:
//   1. A client-side Bedrock model catalog (models_list / models_get_enabled
//      / models_set_enabled) — removed because the model list is served by
//      the Go server's /v1/models (OpenRouter IDs), and the enabled list is
//      read/written through the generic settings_get/settings_update
//      commands. A second, divergent catalog here only reintroduced stale
//      Bedrock IDs into sidex.models.enabled.
//   2. api_keys_list / api_keys_save / api_keys_delete — a second API-key
//      store that duplicated `commands::providers`, writing to the same
//      `sidex.apikey.<provider>` secret slots but gated on a hardcoded
//      four-provider allowlist (openai/google/moonshot/zhipu). providers.rs
//      is the canonical implementation: it covers the full provider list,
//      base URLs, the enable/disable switch, and CLI-login opt-ins. Nothing
//      in the frontend called the api_keys_* commands (it already used
//      providers_status/providers_save/providers_delete), so they were
//      removed outright rather than turned into a shim.
//
// Kept as an empty module (rather than deleted) because `commands::mod`
// still declares `pub mod models;` / `pub use models::*;`, which is out of
// scope here.
