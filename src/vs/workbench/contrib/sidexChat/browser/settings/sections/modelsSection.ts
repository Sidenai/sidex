import type { SettingsSection } from '../sidexSettingsPanel.js';
import { restartServer } from '../../localServer.js';
import { showConfirmDialog } from '../../components/confirmDialog.js';
import { createProductMark, productMarkKind } from '../productMarks.js';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface ProviderModel { id: string; name: string }
interface LocalServerInfo { provider: string; label: string; baseUrl: string; models: string[] }
interface AccountInfo {
	provider: string;
	displayName: string;
	available: boolean;
	expired: boolean;
	connected: boolean;
	location: string;
	credentialKind: string;
	subscriptionTier: string | null;
	accountEmail: string | null;
}
interface ProviderStatusInfo { id: string; label: string; baseUrl: string; configured: boolean; enabled: boolean; source: string | null; keyless: boolean; envVar: string | null }

// The provider catalogue itself lives in Rust (providers_catalog) — this is
// just the shape we render cards from, not a source of truth.
interface ProviderCatalogEntry { id: string; label: string; defaultBaseUrl: string; envVars: string[]; consoleUrl: string; keyless: boolean }

// A configured key is never sent back to the UI. This placeholder marks a
// field as already-set without exposing the value, and doubles as a sentinel
// so the blur/keydown save handlers don't mistake the display value for edited input.
const MASKED_KEY = '••••••••••••';

export class ModelsSection implements SettingsSection {
	private _invoke: Invoke | null;
	private _container: HTMLElement | null = null;
	private _enabledIds: Set<string> = new Set();
	private _customModels: string[] = [];
	/** Display names, where the provider gave one. Keyed by model id. */
	private _modelNames: Map<string, string> = new Map();
	private _providerCatalog: ProviderCatalogEntry[] = [];
	private _providerStatus: Map<string, ProviderStatusInfo> = new Map();
	private _addingCustom = false;
	private _addModelProvider = '';
	private _enabledListContainer: HTMLElement | null = null;
	private _apiKeysContainer: HTMLElement | null = null;
	private _discoveryContainer: HTMLElement | null = null;
	private _customRowContainer: HTMLElement | null = null;
	// The catalog is pushing 30 providers. Once at least one is configured,
	// the rest collapse behind a disclosure by default — this remembers that
	// the user opened it, so re-rendering after a save doesn't snap it shut.
	private _apiKeysExpanded = false;

	constructor(invoke: Invoke | null) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;
		container.innerHTML = '';
		await this._loadState();
		this._renderModelListSection(container);

		// Create API Keys Container placeholder and render it
		this._apiKeysContainer = document.createElement('div');
		container.appendChild(this._apiKeysContainer);
		this._renderApiKeysSection(this._apiKeysContainer);

		this._discoveryContainer = document.createElement('div');
		container.appendChild(this._discoveryContainer);
		void this._renderDiscoverySection(this._discoveryContainer);
	}

	private async _loadState(): Promise<void> {
		if (!this._invoke) { return; }

		try {
			const raw = await this._invoke('settings_get', { section: 'sidex.models.enabled' });
			const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
			// There is no curated catalog to seed from anymore — an unset value
			// just means no models are enabled yet, same as an explicit empty array.
			if (Array.isArray(arr)) { this._enabledIds = new Set(arr); }
		} catch { /* nothing enabled yet */ }

		try {
			const raw = await this._invoke('settings_get', { section: 'sidex.models.custom' });
			const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
			if (Array.isArray(arr)) {
				this._customModels = [];
				for (const entry of arr as Array<string | { id?: string; name?: string }>) {
					const id = typeof entry === 'string' ? entry : entry?.id;
					if (!id) { continue; }
					this._customModels.push(id);
					const name = typeof entry === 'object' ? entry?.name : undefined;
					if (name) { this._modelNames.set(id, name); }
				}
			}
		} catch { /* empty */ }

		// Union in anything enabled that isn't in the registry (e.g. carried
		// over from an older build) so an enabled model never disappears from the list.
		for (const id of this._enabledIds) {
			if (!this._customModels.includes(id)) { this._customModels.push(id); }
		}

		try {
			this._providerCatalog = (await this._invoke('providers_catalog') as ProviderCatalogEntry[]) || [];
		} catch { this._providerCatalog = []; }

		await this._refreshProviderStatus();
	}

	private async _refreshProviderStatus(): Promise<void> {
		if (!this._invoke) { return; }
		try {
			const statuses = (await this._invoke('providers_status') as ProviderStatusInfo[]) || [];
			this._providerStatus = new Map(statuses.map(s => [s.id, s]));
		} catch { /* keep the last known status rather than blanking every card */ }
	}

	private _renderModelListSection(container: HTMLElement): void {
		const section = document.createElement('div');

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Models';
		section.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description sidex-settings-section-desc';
		desc.textContent = 'Add the model IDs your providers serve. Nothing is enabled until you add it here.';
		section.appendChild(desc);

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.cssText = 'display: flex; flex-direction: column;';

		const search = this._buildSearchInput();
		card.appendChild(search);

		const enabledList = document.createElement('div');
		enabledList.className = 'sidex-models-enabled-list';
		this._enabledListContainer = enabledList;
		this._renderEnabledModels(enabledList);
		card.appendChild(enabledList);

		this._customRowContainer = this._buildAddCustomRow();
		card.appendChild(this._customRowContainer);
		section.appendChild(card);
		container.appendChild(section);
	}

	/**
	 * `createCustomDropdown`'s menu has no height cap of its own. That was fine
	 * for a handful of options, but the provider picker here now lists the
	 * whole catalog (pushing 30) and a provider's model list can run into the
	 * dozens — uncapped, the menu would render off the bottom of the screen
	 * with no way to reach the rest. Same contract, just a bounded menu.
	 */
	private _boundedDropdown(options: (string | DropdownOption)[], currentValue: string, onChange: (value: string) => void): HTMLElement {
		const dropdown = createCustomDropdown(options, currentValue, onChange);
		const menu = dropdown.querySelector('.sidex-custom-dropdown-menu') as HTMLElement | null;
		if (menu) { menu.style.cssText += 'max-height:240px;overflow-y:auto;'; }
		return dropdown;
	}

	private _buildSearchInput(): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'sidex-settings-model-search';
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-search';
		wrap.appendChild(icon);
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'Search your models';
		input.addEventListener('input', () => this._onSearch(input.value));
		wrap.appendChild(input);
		return wrap;
	}

	private _renderEnabledModels(container: HTMLElement): void {
		container.innerHTML = '';
		for (const id of this._customModels) {
			container.appendChild(this._buildModelRow(id));
		}
		if (this._customModels.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-row-description';
			empty.style.padding = '8px 14px';
			empty.textContent = 'No models added yet. Add a model ID below to enable it.';
			container.appendChild(empty);
		}
	}

	private _buildModelRow(id: string): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-model-item';
		const displayName = this._modelNames.get(id);
		row.dataset.modelId = id;
		row.dataset.modelName = `${displayName ?? ''} ${id}`.toLowerCase();

		const nameEl = document.createElement('div');
		nameEl.className = 'sidex-settings-model-name';
		nameEl.textContent = displayName ?? id;
		// Keep the routable id visible: two providers can label a model the
		// same way, and the id is what actually gets sent.
		if (displayName) {
			const idEl = document.createElement('span');
			idEl.className = 'sidex-settings-row-description';
			idEl.style.cssText = 'margin-left:8px;opacity:0.6;';
			idEl.textContent = id;
			nameEl.appendChild(idEl);
		}
		row.appendChild(nameEl);

		// Every row here is a user-added model, so removal is always available —
		// there's no curated entry underneath to fall back to.
		const trash = document.createElement('span');
		trash.className = 'codicon codicon-trash sidex-settings-model-remove';
		trash.addEventListener('click', (e) => {
			e.stopPropagation();
			this._removeCustomModel(id);
		});
		row.appendChild(trash);

		const isOn = this._enabledIds.has(id);
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (isOn ? ' on' : '');
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this._enabledIds.has(id)) {
				this._enabledIds.delete(id);
			} else {
				this._enabledIds.add(id);
			}
			this._saveEnabledModels();
			if (this._enabledListContainer) { this._renderEnabledModels(this._enabledListContainer); }
		});
		row.appendChild(toggle);

		return row;
	}

	private _buildAddCustomRow(): HTMLElement {
		const wrap = document.createElement('div');
		wrap.style.cssText = 'padding:12px 20px;';

		if (!this._addingCustom) {
			const btn = document.createElement('span');
			btn.className = 'sidex-settings-link';
			btn.style.cssText = 'font-size:12px;cursor:pointer;';
			btn.textContent = '+ Add Model';
			btn.addEventListener('click', () => {
				this._addingCustom = true;
				this._updateCustomRow();
			});
			wrap.appendChild(btn);
			return wrap;
		}

		const form = document.createElement('div');
		form.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

		const idInput = document.createElement('input');
		idInput.type = 'text';
		idInput.placeholder = 'Model ID (e.g. anthropic/claude-opus-4.6)';

		const suggestions = document.createElement('div');
		suggestions.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);display:flex;flex-direction:column;gap:4px;';

		// Picking a configured provider fetches what it can actually serve, so
		// users aren't guessing at IDs — but the text input below still takes
		// anything, for providers we can't introspect or haven't set a key for.
		const loadSuggestions = async (provider: string): Promise<void> => {
			suggestions.innerHTML = '';
			if (!provider || !this._invoke) { return; }
			suggestions.textContent = 'Loading models…';
			try {
				const models = (await this._invoke('providers_list_models', { provider }) as ProviderModel[]) || [];
				suggestions.innerHTML = '';
				if (models.length === 0) {
					suggestions.textContent = 'No models reported yet — enter an ID manually below.';
					return;
				}
				// Remember the labels now: picking one should carry its name
				// through even though the input only holds the id.
				for (const m of models) {
					if (m?.id && m.name) { this._modelNames.set(m.id, m.name); }
				}
				const label = document.createElement('div');
				label.textContent = `${models.length} available — pick one, or type your own:`;
				suggestions.appendChild(label);
				suggestions.appendChild(this._boundedDropdown(
					models.map(m => m.id), '', (value) => { idInput.value = value; }));
			} catch {
				// Not configured, offline, or the provider just doesn't support
				// listing — the manual text input below still works either way.
				suggestions.textContent = 'Couldn\'t reach this provider to list its models — enter an ID manually below.';
			}
		};

		const providerOptions = [
			{ value: '', label: 'Custom (any provider)' },
			...this._providerCatalog.map(p => ({ value: p.id, label: p.label })),
		];
		form.appendChild(this._boundedDropdown(providerOptions, this._addModelProvider, (value) => {
			this._addModelProvider = value;
			void loadSuggestions(value);
		}));
		form.appendChild(suggestions);

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;align-items:center;gap:8px;';
		const wrapper = document.createElement('div');
		wrapper.className = 'sidex-input-wrapper';
		wrapper.style.flex = '1';
		wrapper.appendChild(idInput);
		row.appendChild(wrapper);

		const addBtn = document.createElement('span');
		addBtn.className = 'sidex-settings-link';
		addBtn.style.cssText = 'font-size:12px;cursor:pointer;font-weight:500;';
		addBtn.textContent = 'Add';
		addBtn.addEventListener('click', () => {
			const val = idInput.value.trim();
			if (val) { this._addCustomModel(val); }
		});
		row.appendChild(addBtn);

		const cancelBtn = document.createElement('span');
		cancelBtn.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer;';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', () => {
			this._addingCustom = false;
			this._addModelProvider = '';
			this._updateCustomRow();
		});
		row.appendChild(cancelBtn);

		idInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { const v = idInput.value.trim(); if (v) { this._addCustomModel(v); } }
			if (e.key === 'Escape') { this._addingCustom = false; this._addModelProvider = ''; this._updateCustomRow(); }
		});
		form.appendChild(row);
		wrap.appendChild(form);

		if (this._addModelProvider) { void loadSuggestions(this._addModelProvider); }

		return wrap;
	}

	private _updateCustomRow(): void {
		if (this._customRowContainer) {
			this._customRowContainer.innerHTML = '';
			const freshRow = this._buildAddCustomRow();
			while (freshRow.firstChild) {
				this._customRowContainer.appendChild(freshRow.firstChild);
			}
		}
	}

	private _onSearch(query: string): void {
		if (!this._container) { return; }
		const q = query.toLowerCase();
		this._container.querySelectorAll('.sidex-settings-model-item').forEach(el => {
			const name = (el as HTMLElement).dataset.modelName || '';
			const id = (el as HTMLElement).dataset.modelId || '';
			(el as HTMLElement).style.display = (!q || name.includes(q) || id.includes(q)) ? '' : 'none';
		});
	}

	private _renderApiKeysSection(container: HTMLElement): void {
		container.innerHTML = '';
		const section = document.createElement('div');
		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'API Keys';
		section.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description sidex-settings-section-desc';
		desc.textContent = 'Configure provider API keys to use models at cost through your own accounts.';
		section.appendChild(desc);

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const configured: ProviderCatalogEntry[] = [];
		const rest: ProviderCatalogEntry[] = [];
		for (const provider of this._providerCatalog) {
			(this._providerStatus.get(provider.id)?.configured ? configured : rest).push(provider);
		}

		// Past a handful of providers the full catalog is too long to scan on
		// open, so whatever is already working stays pinned in view and
		// everything else collapses behind a disclosure. On a fresh install
		// nothing is configured yet, so there's no "long tail" to hide —
		// showing the whole list is what's actually useful there.
		if (configured.length > 0) {
			const header = document.createElement('div');
			header.className = 'sidex-settings-model-group-header';
			header.textContent = 'Configured';
			card.appendChild(header);
			for (const provider of configured) { card.appendChild(this._buildProviderCard(provider)); }
		}

		if (rest.length > 0) {
			if (configured.length === 0) {
				for (const provider of rest) { card.appendChild(this._buildProviderCard(provider)); }
			} else {
				const expanded = this._apiKeysExpanded;
				const disclosureHeader = document.createElement('div');
				disclosureHeader.className = 'sidex-settings-expandable-header' + (expanded ? ' expanded' : '');
				const chevron = document.createElement('span');
				chevron.className = 'codicon codicon-chevron-right';
				disclosureHeader.appendChild(chevron);
				const disclosureLabel = document.createElement('span');
				disclosureLabel.textContent = `${rest.length} more provider${rest.length === 1 ? '' : 's'}`;
				disclosureHeader.appendChild(disclosureLabel);
				disclosureHeader.addEventListener('click', () => {
					this._apiKeysExpanded = !this._apiKeysExpanded;
					this._renderApiKeysSection(container);
				});
				card.appendChild(disclosureHeader);

				const disclosureContent = document.createElement('div');
				disclosureContent.className = 'sidex-settings-expandable-content' + (expanded ? ' visible' : '');
				for (const provider of rest) { disclosureContent.appendChild(this._buildProviderCard(provider)); }
				card.appendChild(disclosureContent);
			}
		}

		section.appendChild(card);
		container.appendChild(section);
	}

	/**
	 * A generic "OpenAI-compatible" entry has no fixed console to send people
	 * to and no default endpoint to fall back on, unlike every named provider
	 * in the catalog — so the copy has to describe what's actually true for
	 * this card rather than assume a console link and a working default.
	 */
	private _providerDescriptionHtml(config: ProviderCatalogEntry): string {
		if (config.keyless) {
			return `${config.label} doesn't require a key. Set a base URL below if it isn't running at the default location.`;
		}
		const keyPart = config.consoleUrl
			? `Get a key from <a href="${config.consoleUrl}" class="sidex-settings-link" target="_blank">${config.label}</a> to use its models at cost.`
			: `Enter an API key to use ${config.label} models at cost.`;
		const envPart = config.envVars.length ? ` Picked up automatically if ${config.envVars.join(' or ')} is already set in your shell.` : '';
		const baseUrlPart = config.defaultBaseUrl ? '' : ' This provider has no default endpoint, so a base URL is required below.';
		return keyPart + envPart + baseUrlPart;
	}

	private _buildProviderCard(config: ProviderCatalogEntry): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		// The row itself is a flex container, so the label and its description
		// have to share one column or they end up side by side.
		// The row itself is a flex container, so label and description have to
		// live in one column or they land side by side. The text column sits
		// beside the toggle rather than under it, so the description lines up
		// with the label whatever width the toggle happens to be.
		const infoCol = document.createElement('div');
		infoCol.style.cssText = 'display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1;padding-right:16px;';

		const textCol = document.createElement('div');
		textCol.style.cssText = 'display:flex;flex-direction:column;min-width:0;';

		const titleWrap = document.createElement('div');
		titleWrap.style.cssText = 'display:flex;align-items:center;';

		const status = this._providerStatus.get(config.id);
		// `enabled` is the user's on/off choice; `configured` is whether a
		// credential exists. A keyless provider is always configured, so the
		// toggle has to follow `enabled` or it can never be switched off.
		const isEnabled = status?.enabled !== false;
		const hasCredential = status?.configured ?? false;
		const isOn = isEnabled && hasCredential;
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (isOn ? ' on' : '');
		toggle.style.flexShrink = '0';
		toggle.style.marginTop = '1px';
		infoCol.appendChild(toggle);

		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.textContent = config.label;
		titleWrap.appendChild(label);

		textCol.appendChild(titleWrap);

		const descEl = document.createElement('div');
		descEl.className = 'sidex-settings-row-description';
		descEl.innerHTML = this._providerDescriptionHtml(config);
		descEl.querySelectorAll('a').forEach(link => {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const href = link.getAttribute('href');
				if (href && this._invoke) {
					this._invoke('open_external_url', { url: href }).catch(() => {
						window.open(href, '_blank');
					});
				}
			});
		});
		textCol.appendChild(descEl);
		infoCol.appendChild(textCol);
		row.appendChild(infoCol);

		const fieldsWrap = document.createElement('div');
		fieldsWrap.className = 'sidex-settings-row-action';
		fieldsWrap.style.cssText = 'flex-direction:column;gap:6px;flex-shrink:0;';

		// A provider that ships with no default base URL has nothing to fall
		// back to — leaving it blank wouldn't "use the default", it would
		// resolve to an empty endpoint. The field has to be required, not
		// merely suggested.
		const needsBaseUrl = !config.defaultBaseUrl;
		interface FieldSpec { id: 'apiKey' | 'baseUrl'; type: string; placeholder: string; prefill?: string; required?: boolean }
		const fields: FieldSpec[] = [];
		if (!config.keyless) {
			fields.push({ id: 'apiKey', type: 'password', placeholder: `Enter your ${config.label} API Key` });
		}
		fields.push({
			id: 'baseUrl', type: 'text',
			placeholder: needsBaseUrl ? 'Base URL (required, e.g. https://your-host/v1)' : config.defaultBaseUrl,
			prefill: status?.baseUrl && status.baseUrl !== config.defaultBaseUrl ? status.baseUrl : undefined,
			required: needsBaseUrl,
		});

		// Populated once the fields below exist, and read by both the field
		// loop and the save call — declared here so both can see it.
		const errorEl = document.createElement('div');
		errorEl.className = 'sidex-settings-row-description';
		errorEl.style.cssText = 'display:none;max-width:260px;color:var(--vscode-editorError-foreground, #f85149);';

		const fieldInputs: Map<string, HTMLInputElement> = new Map();
		for (const field of fields) {
			const wrapper = document.createElement('div');
			wrapper.className = 'sidex-input-wrapper';
			const input = document.createElement('input');
			input.type = field.type;
			input.placeholder = field.placeholder;
			if (field.required) {
				input.setAttribute('aria-required', 'true');
			}
			if (field.prefill) { input.value = field.prefill; }
			if (hasCredential && field.type === 'password') {
				input.value = MASKED_KEY;
				input.disabled = true;
			}
			// Saving restarts the server and re-renders this section, which
			// destroys the focused input and fires another blur. Without an
			// equality check that loops: the base URL field is pre-filled, so
			// it always looks "dirty" on the way out.
			const initialValue = input.value;
			const saveIfChanged = async (): Promise<void> => {
				if (input.value === initialValue || input.value === MASKED_KEY) { return; }
				const error = await this._saveProviderKey(config, fieldInputs);
				errorEl.textContent = error ?? '';
				errorEl.style.display = error ? '' : 'none';
			};
			input.addEventListener('blur', () => { void saveIfChanged(); });
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { void saveIfChanged(); }
			});
			// A fresh edit makes the last save attempt's error stale — clear it
			// rather than leaving it pinned under the field they're now fixing.
			input.addEventListener('input', () => { errorEl.style.display = 'none'; });
			wrapper.appendChild(input);
			fieldInputs.set(field.id, input);
			fieldsWrap.appendChild(wrapper);
		}
		fieldsWrap.appendChild(errorEl);

		// The model list is only worth fetching once the provider can actually
		// resolve a request — offering it while off or unconfigured would just
		// trade one silent failure for a confusing one.
		if (isOn) {
			fieldsWrap.appendChild(this._buildImportModelsRow(config));
		}
		row.appendChild(fieldsWrap);

		toggle.addEventListener('click', async () => {
			if (isOn) {
				await this._setProviderEnabled(config.id, false);
				return;
			}
			// Re-enabling something that already has a credential (or needs
			// none) just switches it back on; otherwise the user still has to
			// supply a key, so put the cursor where they can.
			if (!isEnabled && hasCredential) {
				await this._setProviderEnabled(config.id, true);
				return;
			}
			const firstInput = Array.from(fieldInputs.values())[0];
			if (firstInput) { firstInput.focus(); }
		});

		return row;
	}

	/**
	 * Per-card "pull in this provider's real models" action. `_adoptModelsFrom`
	 * already does the work (it's also called right after a connect/enable),
	 * but that was the only way to reach it — a provider configured earlier in
	 * the session, or one whose auto-adopt found nothing the first time, had
	 * no way to retry. This puts the same helper one click away on every
	 * configured card, and — unlike those call sites, which treat a failure as
	 * best-effort — reports it back instead of swallowing it.
	 */
	private _buildImportModelsRow(config: ProviderCatalogEntry): HTMLElement {
		const wrap = document.createElement('div');
		wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

		const link = document.createElement('span');
		link.className = 'sidex-settings-link';
		link.style.cssText = 'font-size:11px;cursor:pointer;white-space:nowrap;';
		link.textContent = 'Import models';
		wrap.appendChild(link);

		const resultEl = document.createElement('span');
		resultEl.className = 'sidex-settings-row-description';
		resultEl.style.margin = '0';
		wrap.appendChild(resultEl);

		const run = async (): Promise<void> => {
			link.style.pointerEvents = 'none';
			link.style.opacity = '0.5';
			resultEl.style.color = '';
			resultEl.textContent = 'Importing…';
			try {
				const added = await this._adoptModelsFrom(config.id);
				resultEl.textContent = added > 0
					? `Added ${added} model${added === 1 ? '' : 's'}.`
					: 'No new models found.';
			} catch (e) {
				resultEl.textContent = e instanceof Error ? e.message : String(e);
				resultEl.style.color = 'var(--vscode-editorError-foreground, #f85149)';
			} finally {
				link.style.pointerEvents = '';
				link.style.opacity = '';
			}
		};
		link.addEventListener('click', () => { void run(); });

		return wrap;
	}

	/**
	 * Everything the app can already reach without the user typing a key:
	 * loopback model servers, an existing Claude Code / Codex login, and keys
	 * already exported in their shell.
	 */
	private async _renderDiscoverySection(container: HTMLElement): Promise<void> {
		container.innerHTML = '';
		if (!this._invoke) { return; }

		const section = document.createElement('div');
		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Detected on this machine';
		section.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description sidex-settings-section-desc';
		desc.textContent = 'Credentials and model servers SideX can use without any setup. No account required.';
		section.appendChild(desc);

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const [local, accounts, statuses] = await Promise.all([
			this._invoke('providers_detect_local').catch(() => []) as Promise<LocalServerInfo[]>,
			this._invoke('accounts_list').catch(() => []) as Promise<AccountInfo[]>,
			this._invoke('providers_status').catch(() => []) as Promise<ProviderStatusInfo[]>,
		]);

		// --- local model servers ---
		if (local.length === 0) {
			card.appendChild(this._buildInfoRow(
				'No local model server found',
				'Start Ollama or LM Studio and reopen this panel to use local models with no key.'));
		} else {
			for (const server of local) {
				const count = server.models.length;
				card.appendChild(this._buildInfoRow(
					`${server.label} — ready`,
					count > 0
						? `${count} model${count === 1 ? '' : 's'} at ${server.baseUrl}`
						: `Running at ${server.baseUrl}, but no models are pulled yet.`));
			}
		}

		// --- connect an account you are already signed into ---
		for (const account of accounts) {
			const row = document.createElement('div');
			row.className = 'sidex-settings-row';

			const infoCol = document.createElement('div');
			infoCol.style.cssText = 'display:flex;flex-direction:column;min-width:0;flex:1;padding-right:16px;';

			const labelRow = document.createElement('div');
			labelRow.className = 'sidex-product-label-row';
			const markKind = productMarkKind(account.provider) ?? productMarkKind(account.displayName);
			if (markKind) {
				labelRow.appendChild(createProductMark(markKind));
			}
			const label = document.createElement('div');
			label.className = 'sidex-settings-row-label';
			label.textContent = `${account.displayName} account`;
			labelRow.appendChild(label);
			infoCol.appendChild(labelRow);

			const action = document.createElement('button');
			action.className = 'sidex-settings-btn';
			action.style.cssText = 'flex-shrink:0;white-space:nowrap;';
			if (account.connected) {
				action.textContent = 'Disconnect';
			} else {
				action.textContent = 'Connect';
				action.disabled = !account.available;
			}

			const sub = document.createElement('div');
			sub.className = 'sidex-settings-row-description';
			sub.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
			const who = account.accountEmail
				? `${account.accountEmail}${account.subscriptionTier ? ` · ${account.subscriptionTier}` : ''}`
				: account.subscriptionTier ?? '';
			if (account.expired) {
				sub.textContent = `Signed out or expired. Sign in with ${account.displayName} again, then reconnect.`;
			} else if (account.connected) {
				sub.textContent = who
					? `Connected — ${who}`
					: `Connected — using the login at ${account.location}`;
			} else if (account.available) {
				sub.textContent = who
					? `Signed in as ${who}. Connect to use it for ${account.provider} models.`
					: `Found at ${account.location}. Connect to use it for ${account.provider} models.`;
			} else {
				sub.textContent = `Not signed in to ${account.displayName} on this machine.`;
			}
			infoCol.appendChild(sub);

			// A subscription login is issued for that CLI. Say so plainly rather
			// than letting someone connect it without knowing.
			if (account.available && account.credentialKind === 'oauth') {
				const warn = document.createElement('div');
				warn.className = 'sidex-settings-row-description';
				warn.style.cssText = 'color:var(--vscode-editorWarning-foreground);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
				warn.textContent = 'Subscription login, not a billed API key.';
				infoCol.appendChild(warn);
			}
			row.appendChild(infoCol);
			row.appendChild(action);

			if (account.connected || account.available) {
				action.addEventListener('click', () => {
					void this._setAccountConnected(account, !account.connected, sub);
				});
			}
			card.appendChild(row);
		}

		// --- keys already in the environment ---
		const fromEnv = statuses.filter(p => p.source === 'env');
		for (const p of fromEnv) {
			card.appendChild(this._buildInfoRow(
				`${p.label} — using ${p.envVar ?? 'your environment'}`,
				'Picked up from your shell. A key entered above overrides it.'));
		}

		section.appendChild(card);
		container.appendChild(section);
	}

	private _buildInfoRow(label: string, description: string): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const labelEl = document.createElement('div');
		labelEl.className = 'sidex-settings-row-label';
		labelEl.textContent = label;
		row.appendChild(labelEl);

		const descEl = document.createElement('div');
		descEl.className = 'sidex-settings-row-description';
		descEl.textContent = description;
		row.appendChild(descEl);
		return row;
	}

	/**
	 * Connecting hands another product's credential to the agent, so it asks
	 * first rather than flipping silently on a single click.
	 */
	private async _confirmAccountChange(account: AccountInfo, connect: boolean): Promise<boolean> {
		if (!connect) {
			return showConfirmDialog({
				title: `Disconnect ${account.displayName}?`,
				body: [
					`SideX will stop using your ${account.displayName} login for ${account.provider} models.`,
					'Your login itself is untouched — this only stops SideX reading it.'
				],
				confirmLabel: 'Disconnect',
				danger: true
			});
		}

		const who = account.accountEmail ?? 'the account signed in on this machine';
		const body = [
			`SideX will use your ${account.displayName} login (${who}) to run ${account.provider} models.`,
			`The credential is read from ${account.location} and passed only to the agent server running on your own machine. It is never sent anywhere else, and never shown in the app.`
		];

		return showConfirmDialog({
			title: `Connect ${account.displayName}?`,
			body,
			// A subscription login is issued for that product. Say so before the
			// user commits, not after.
			caution: account.credentialKind === 'oauth'
				? `This is a subscription login, not a billed API key. Using it from another app may not be permitted by ${account.displayName}'s terms — entering an API key above avoids that entirely.`
				: undefined,
			confirmLabel: 'Connect'
		});
	}

	private async _setAccountConnected(account: AccountInfo, connect: boolean, statusEl: HTMLElement): Promise<void> {
		if (!this._invoke) { return; }

		if (!await this._confirmAccountChange(account, connect)) { return; }

		statusEl.textContent = connect
			? `Connecting your ${account.displayName} account…`
			: `Disconnecting your ${account.displayName} account…`;
		statusEl.style.color = '';

		try {
			await this._invoke(connect ? 'accounts_connect' : 'accounts_disconnect', { provider: account.provider });
			// A freshly connected account is useless without models, so pull in
			// what it can actually reach before re-rendering. Caught locally,
			// not by the catch below: a model-listing hiccup right after connect
			// shouldn't be reported as the connect itself having failed — the
			// "Import models" action on the card covers retrying it.
			if (connect) {
				try {
					const added = await this._adoptModelsFrom(account.provider);
					if (added > 0) {
						statusEl.textContent = `Connected — added ${added} model${added === 1 ? '' : 's'}.`;
						// Do NOT persist a model here: the user didn't explicitly
						// choose one. Forcing the first account model into
						// localStorage pins a stale snapshot ID that survives
						// future re-fetches. Leave the selection unset so it
						// re-resolves to whatever the account currently serves.
					}
				} catch { /* connected fine; the card's own Import models action can retry */ }
			}
			await this._applyCredentialChange();
		} catch (e) {
			// Connecting fails when the login is missing or expired; the Rust
			// side returns a message written for the user, so show it in place.
			statusEl.textContent = e instanceof Error ? e.message : String(e);
			statusEl.style.color = 'var(--vscode-editorError-foreground)';
		}
	}

	/**
	 * Save whatever changed on a provider card. Returns a user-facing message
	 * on failure — a rejected key, a malformed base URL, or (for a provider
	 * with no shipped default) no URL at all — so the card that caused it can
	 * show the message inline instead of the failure disappearing into the
	 * console. Returns `null` on success or when there was nothing to save.
	 */
	private async _saveProviderKey(config: ProviderCatalogEntry, inputs: Map<string, HTMLInputElement>): Promise<string | null> {
		if (!this._invoke) { return null; }
		const apiKeyInput = inputs.get('apiKey');
		// A disabled field is showing the masked placeholder, not a real
		// value — never forward that as the key to save.
		const apiKey = apiKeyInput && !apiKeyInput.disabled ? apiKeyInput.value.trim() || null : null;
		const baseUrl = inputs.get('baseUrl')?.value.trim() || null;
		if (!apiKey && !baseUrl) { return null; }

		// A provider that ships with no default base URL has nowhere to fall
		// back to — an empty base URL would resolve to "" on the Rust side and
		// every request would just fail. Catch that here instead of letting
		// the save "succeed" into a provider that can never actually resolve.
		if (!config.defaultBaseUrl && !baseUrl && !this._providerStatus.get(config.id)?.baseUrl) {
			return `${config.label} has no default endpoint — enter a base URL to save.`;
		}

		try {
			await this._invoke('providers_save', { provider: config.id, apiKey, baseUrl });
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
		await this._applyCredentialChange();
		return null;
	}

	/**
	 * Credentials reach the model server through its environment, which is read
	 * once at spawn — so a change only takes effect after a restart.
	 */
	private _applyingCredentialChange = false;

	private async _applyCredentialChange(): Promise<void> {
		// Re-render can trigger blur handlers, so refuse to re-enter rather
		// than restarting the server in a loop.
		if (this._applyingCredentialChange) { return; }
		this._applyingCredentialChange = true;
		try {
			await this._doApplyCredentialChange();
		} finally {
			this._applyingCredentialChange = false;
		}
	}

	private async _doApplyCredentialChange(): Promise<void> {
		// Re-rendering resets scroll to the top, which is jarring when the user
		// is part-way down a long provider list.
		const scroller = this._container?.closest('.sidex-settings-content') as HTMLElement | null;
		const scrollTop = scroller?.scrollTop ?? 0;

		try {
			await restartServer();
		} catch { /* the chat panel surfaces the disconnected state on its own */ }
		await this._refreshProviderStatus();
		if (this._apiKeysContainer) { this._renderApiKeysSection(this._apiKeysContainer); }
		if (this._discoveryContainer) { await this._renderDiscoverySection(this._discoveryContainer); }

		if (scroller) { scroller.scrollTop = scrollTop; }
	}

	private async _setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
		if (!this._invoke) { return; }
		try {
			await this._invoke('providers_set_enabled', { provider, enabled });
			if (enabled) {
				// Best-effort, same as on account connect: the toggle flipping on
				// is the part that must not fail here, so a model-listing hiccup
				// (not reachable yet, nothing exposed) is swallowed rather than
				// reported as "failed to enable". The card's own Import models
				// action covers retrying it.
				try { await this._adoptModelsFrom(provider); } catch { /* see above */ }
			}
			await this._applyCredentialChange();
		} catch (e) { console.error(`Failed to ${enabled ? 'enable' : 'disable'} ${provider}:`, e); }
	}

	/**
	 * Pull in the models a newly-usable provider actually offers.
	 *
	 * Without this the user connects an account and still faces an empty model
	 * list. Only models we don't already know about are added, and they are
	 * enabled so the provider is usable straight away.
	 *
	 * Listing can fail for a subscription login even when chat will work
	 * (or the other way around). Fall back to the known-good ids for that
	 * provider so Connect still leaves the picker usable.
	 */
	private static readonly FALLBACK_ACCOUNT_MODELS: Record<string, ProviderModel[]> = {
		anthropic: [
			{ id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
			{ id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
			{ id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
		],
		openai: [
			{ id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
			{ id: 'openai/gpt-5.5', name: 'GPT-5.5' },
			{ id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 mini' },
		],
	};

	private async _adoptModelsFrom(provider: string): Promise<number> {
		if (!this._invoke) { return 0; }
		let models: ProviderModel[] = [];
		try {
			models = (await this._invoke('providers_list_models', { provider }) as ProviderModel[]) || [];
		} catch {
			models = [];
		}
		if (models.length === 0) {
			models = ModelsSection.FALLBACK_ACCOUNT_MODELS[provider] ?? [];
		}
		// Record names even for models already known, so a stale entry added by
		// hand picks up its proper label.
		for (const m of models) {
			if (m?.id && m.name) { this._modelNames.set(m.id, m.name); }
		}
		const added = models.map(m => m?.id).filter((id): id is string => !!id && !this._customModels.includes(id));
		if (added.length === 0) { return 0; }

		this._customModels.push(...added);
		for (const id of added) { this._enabledIds.add(id); }
		await this._saveCustomModels();
		await this._saveEnabledModels();
		if (this._enabledListContainer) { this._renderEnabledModels(this._enabledListContainer); }
		return added.length;
	}

	private async _deleteProviderKey(provider: string): Promise<void> {
		if (!this._invoke) { return; }
		try {
			await this._invoke('providers_delete', { provider });
			await this._applyCredentialChange();
		} catch (e) { console.error(`Failed to delete key for ${provider}:`, e); }
	}

	private async _saveCustomModels(): Promise<void> {
		if (!this._invoke) { return; }
		const value = this._customModels.map(id => {
			const name = this._modelNames.get(id);
			return name ? { id, name } : id;
		});
		await this._invoke('settings_update', { key: 'sidex.models.custom', value, scope: 'user' });
	}

	private async _saveEnabledModels(): Promise<void> {
		if (!this._invoke) { return; }
		try {
			// Store as a real JSON array (not a stringified string) so every
			// reader — Rust models_get_enabled, the chat service, this panel —
			// sees the same type.
			await this._invoke('settings_update', { key: 'sidex.models.enabled', value: [...this._enabledIds], scope: 'user' });
			// Tell the chat service to re-filter its model list immediately
			window.dispatchEvent(new CustomEvent('sidex-models-changed'));
		} catch (e) { console.error('Failed to save enabled models:', e); }
	}

	private async _addCustomModel(id: string): Promise<void> {
		if (!this._invoke) { return; }
		if (!this._customModels.includes(id)) { this._customModels.push(id); }
		this._enabledIds.add(id);
		this._addingCustom = false;
		this._addModelProvider = '';
		try {
			await this._saveCustomModels();
			await this._saveEnabledModels();
		} catch (e) { console.error('Failed to add custom model:', e); }

		if (this._enabledListContainer) { this._renderEnabledModels(this._enabledListContainer); }
		this._updateCustomRow();
	}

	private async _removeCustomModel(id: string): Promise<void> {
		if (!this._invoke) { return; }
		this._customModels = this._customModels.filter(m => m !== id);
		this._enabledIds.delete(id);
		try {
			await this._saveCustomModels();
			await this._saveEnabledModels();
		} catch (e) { console.error('Failed to remove custom model:', e); }

		if (this._enabledListContainer) { this._renderEnabledModels(this._enabledListContainer); }
	}

	dispose(): void {
		this._container = null;
	}
}
