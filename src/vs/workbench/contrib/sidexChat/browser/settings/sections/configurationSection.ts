/*---------------------------------------------------------------------------------------------
 *  Configuration section for SideX Settings panel.
 *  Cascade agent runtime policies, terminal preferences, auto-continue, lints, and web search.
 *  Includes allowed/denied command patterns, auto web requests, and allowed origins lists.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface SettingsData {
	[key: string]: unknown;
}

const DEFAULT_ORIGINS = [
	'https://en.wikipedia.org',
	'https://developer.mozilla.org',
	'https://stackoverflow.com',
	'https://arxiv.org',
	'https://docs.python.org',
	'https://pkg.go.dev',
	'https://go.dev',
	'https://docs.rs',
	'https://pypi.org',
	'https://www.npmjs.com',
	'https://crates.io',
	'https://github.com',
	'https://www.google.com',
	'https://scholar.google.com',
	'https://deepwiki.org'
];

export class ConfigurationSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _settings: SettingsData = {};

	private _origins: string[] = [...DEFAULT_ORIGINS];
	private _allowList: string[] = [];
	private _denyList: string[] = [];

	private _originsContainer!: HTMLElement;
	private _allowListContainer!: HTMLElement;
	private _denyListContainer!: HTMLElement;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		if (this._invoke) {
			try {
				const data = await this._invoke('settings_get', { section: 'sidex.cascade' }) as SettingsData | null;
				if (data) {
					this._settings = data;
					if (typeof data.allowedOrigins === 'string') {
						this._origins = JSON.parse(data.allowedOrigins as string);
					}
					if (typeof data.allowList === 'string') {
						this._allowList = JSON.parse(data.allowList as string);
					}
					if (typeof data.denyList === 'string') {
						this._denyList = JSON.parse(data.denyList as string);
					}
				}
			} catch { /* use defaults */ }
		}

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Configuration';
		container.appendChild(title);

		const card1 = document.createElement('div');
		card1.className = 'sidex-settings-card';

		// 1. Allow Sidex in background
		const bgRow = this._createRow(card1, 'Allow Sidex in background', 'Sidex keeps running when you switch conversations. Terminal commands may run in the background depending on your auto execution setting');
		this._addToggle(bgRow, this._getSetting('background', true) as boolean, 'sidex.cascade.background');

		// 2. Auto-open edited files
		const openFilesRow = this._createRow(card1, 'Auto-open edited files', 'Open files in the background if Sidex creates or edits them');
		this._addToggle(openFilesRow, this._getSetting('autoOpenFiles', true) as boolean, 'sidex.cascade.autoOpenFiles');

		// 3. Sidex preview
		const previewsRow = this._createRow(card1, 'Sidex preview', 'Sidex opens browser previews of dev servers it starts, integrating tightly with your workflow');
		this._addToggle(previewsRow, this._getSetting('previews', true) as boolean, 'sidex.cascade.previews');

		// 4. Gitignore access
		const gitignoreRow = this._createRow(card1, 'Gitignore access', 'Let Sidex, tab, and supercomplete view and edit files in .gitignore');
		this._addToggle(gitignoreRow, this._getSetting('gitignoreAccess', false) as boolean, 'sidex.cascade.gitignoreAccess');

		container.appendChild(card1);

		// Card 3: Auto Web Requests Policy Card
		const card3 = document.createElement('div');
		card3.className = 'sidex-settings-card';

		// 15. Auto web requests policy
		const reqRow = this._createRow(card3, 'Auto web requests', 'Disabled (manual approval), Allowlist (only approved origins), Turbo (always fetch)');
		this._addSelect(reqRow, ['Disabled', 'Allowlist', 'Turbo'], this._getSetting('autoWebRequestsPolicy', 'Allowlist') as string, 'sidex.cascade.autoWebRequestsPolicy');

		// 15a. Allowed origins list box
		this._originsContainer = document.createElement('div');
		card3.appendChild(this._originsContainer);
		this._renderOriginsSection();

		container.appendChild(card3);
	}

	private _getSetting(key: string, defaultValue: unknown): unknown {
		return this._settings[key] ?? defaultValue;
	}

	private _saveLists(key: string, value: string[]): void {
		if (this._invoke) {
			this._invoke('settings_update', { key: `sidex.cascade.${key}`, value: JSON.stringify(value), scope: 'user' }).catch(() => {});
		}
	}

	private _createRow(parent: HTMLElement, label: string, description?: string): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.className = 'sidex-settings-row-label';
		lbl.textContent = label;
		left.appendChild(lbl);

		if (description) {
			const desc = document.createElement('div');
			desc.className = 'sidex-settings-row-description';
			desc.textContent = description;
			left.appendChild(desc);
		}
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		row.appendChild(action);

		parent.appendChild(row);
		return row;
	}

	private _addToggle(row: HTMLElement, initialState: boolean, settingKey: string): HTMLElement {
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (initialState ? ' on' : '');
		toggle.addEventListener('click', () => {
			toggle.classList.toggle('on');
			const value = toggle.classList.contains('on');
			if (this._invoke) {
				this._invoke('settings_update', { key: settingKey, value, scope: 'user' }).catch(() => {});
			}
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(toggle);
		return toggle;
	}

	private _addSelect(row: HTMLElement, options: string[], defaultValue: string, settingKey: string): HTMLElement {
		const dropdown = createCustomDropdown(options, defaultValue, (newValue) => {
			if (this._invoke) {
				this._invoke('settings_update', { key: settingKey, value: newValue, scope: 'user' }).catch(() => {});
			}
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(dropdown);
		return dropdown;
	}

	// Allowed/Denied Command Lists Renderer
	private _renderCommandListSection(container: HTMLElement, label: string, description: string, key: 'allowList' | 'denyList', list: string[]): void {
		container.innerHTML = '';
		container.style.cssText = 'padding: 14px 20px 20px;';

		const header = document.createElement('div');
		header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;';
		
		const title = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.style.cssText = 'font-size:13px; font-weight:500; color:var(--vscode-foreground);';
		lbl.textContent = label;
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = description;
		title.appendChild(lbl);
		title.appendChild(desc);
		header.appendChild(title);

		const addBtn = document.createElement('button');
		addBtn.className = 'sidex-settings-btn';
		addBtn.textContent = 'Add';
		addBtn.addEventListener('click', () => {
			const val = prompt(`Enter command pattern to add to ${label} (e.g. "git *" or "npm run test"):`);
			if (val && val.trim()) {
				list.push(val.trim());
				this._saveLists(key, list);
				this._renderCommandListSection(container, label, description, key, list);
			}
		});
		header.appendChild(addBtn);
		container.appendChild(header);

		const listBox = document.createElement('div');
		listBox.className = 'sidex-settings-list-box';

		const listScroll = document.createElement('div');
		listScroll.className = 'sidex-settings-list-scroll';
		listBox.appendChild(listScroll);
		
		if (list.length === 0) {
			const empty = document.createElement('div');
			empty.style.cssText = 'display:flex; align-items:center; justify-content:center; height:120px; font-size:12px; color:var(--vscode-descriptionForeground);';
			empty.textContent = 'No items';
			listScroll.appendChild(empty);
		} else {
			list.forEach((item, idx) => {
				const row = document.createElement('div');
				row.className = 'sidex-settings-list-item';

				const txt = document.createElement('span');
				txt.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
				txt.textContent = item;
				row.appendChild(txt);

				const actions = document.createElement('div');
				actions.className = 'sidex-settings-list-item-actions';

				const editBtn = document.createElement('span');
				editBtn.className = 'codicon codicon-edit sidex-settings-list-action-btn';
				editBtn.addEventListener('click', () => {
					const val = prompt(`Edit command pattern:`, item);
					if (val && val.trim()) {
						list[idx] = val.trim();
						this._saveLists(key, list);
						this._renderCommandListSection(container, label, description, key, list);
					}
				});
				actions.appendChild(editBtn);

				const delBtn = document.createElement('span');
				delBtn.className = 'codicon codicon-trash sidex-settings-list-action-btn';
				delBtn.style.color = 'var(--vscode-errorForeground)';
				delBtn.addEventListener('click', () => {
					list.splice(idx, 1);
					this._saveLists(key, list);
					this._renderCommandListSection(container, label, description, key, list);
				});
				actions.appendChild(delBtn);

				row.appendChild(actions);
				listScroll.appendChild(row);
			});
		}
		container.appendChild(listBox);
	}

	// Allowed Origins Section Renderer
	private _renderOriginsSection(): void {
		const container = this._originsContainer;
		container.innerHTML = '';
		container.style.cssText = 'padding: 14px 20px 20px;';

		const textDesc = document.createElement('p');
		textDesc.style.cssText = 'font-size:12px; color:var(--vscode-descriptionForeground); margin:0 0 12px; line-height:1.5;';
		textDesc.textContent = 'Origins must include the scheme and port if non-default (e.g., "https://github.com" or "http://localhost:3000").';
		container.appendChild(textDesc);

		const header = document.createElement('div');
		header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;';
		
		const title = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.style.cssText = 'font-size:13px; font-weight:500; color:var(--vscode-foreground);';
		lbl.textContent = 'Allowed origins';
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'Origins Sidex auto-fetches URLs from';
		title.appendChild(lbl);
		title.appendChild(desc);
		header.appendChild(title);

		const addBtn = document.createElement('button');
		addBtn.className = 'sidex-settings-btn';
		addBtn.textContent = 'Add';
		addBtn.addEventListener('click', () => {
			const val = prompt('Enter origin URL to add (e.g. "https://api.github.com"):');
			if (val && val.trim()) {
				this._origins.push(val.trim());
				this._saveLists('allowedOrigins', this._origins);
				this._renderOriginsSection();
			}
		});
		header.appendChild(addBtn);
		container.appendChild(header);

		const listBox = document.createElement('div');
		listBox.className = 'sidex-settings-list-box';

		const listScroll = document.createElement('div');
		listScroll.className = 'sidex-settings-list-scroll';
		listBox.appendChild(listScroll);

		if (this._origins.length === 0) {
			const empty = document.createElement('div');
			empty.style.cssText = 'display:flex; align-items:center; justify-content:center; height:120px; font-size:12px; color:var(--vscode-descriptionForeground);';
			empty.textContent = 'No items';
			listScroll.appendChild(empty);
		} else {
			this._origins.forEach((origin, idx) => {
				const row = document.createElement('div');
				row.className = 'sidex-settings-list-item';

				const txt = document.createElement('span');
				txt.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
				txt.textContent = origin;
				row.appendChild(txt);

				const actions = document.createElement('div');
				actions.className = 'sidex-settings-list-item-actions';

				const editBtn = document.createElement('span');
				editBtn.className = 'codicon codicon-edit sidex-settings-list-action-btn';
				editBtn.addEventListener('click', () => {
					const val = prompt('Edit origin URL:', origin);
					if (val && val.trim()) {
						this._origins[idx] = val.trim();
						this._saveLists('allowedOrigins', this._origins);
						this._renderOriginsSection();
					}
				});
				actions.appendChild(editBtn);

				const delBtn = document.createElement('span');
				delBtn.className = 'codicon codicon-trash sidex-settings-list-action-btn';
				delBtn.style.color = 'var(--vscode-errorForeground)';
				delBtn.addEventListener('click', () => {
					this._origins.splice(idx, 1);
					this._saveLists('allowedOrigins', this._origins);
					this._renderOriginsSection();
				});
				actions.appendChild(delBtn);

				row.appendChild(actions);
				listScroll.appendChild(row);
			});
		}
		container.appendChild(listBox);

		// Import / Export / Reset controls
		const footer = document.createElement('div');
		footer.style.cssText = 'display:flex; gap:8px; margin-top:12px;';

		const importBtn = document.createElement('button');
		importBtn.className = 'sidex-settings-btn';
		importBtn.textContent = 'Import';
		importBtn.addEventListener('click', () => {
			alert('Import allowed origins CSV/TXT...');
		});
		footer.appendChild(importBtn);

		const exportBtn = document.createElement('button');
		exportBtn.className = 'sidex-settings-btn';
		exportBtn.textContent = 'Export';
		exportBtn.addEventListener('click', () => {
			alert('Exporting allowed origins list as CSV...');
		});
		footer.appendChild(exportBtn);

		const resetBtn = document.createElement('button');
		resetBtn.className = 'sidex-settings-btn';
		resetBtn.style.marginLeft = 'auto';
		resetBtn.textContent = 'Reset to defaults';
		resetBtn.addEventListener('click', () => {
			if (confirm('Are you sure you want to reset allowed origins back to defaults?')) {
				this._origins = [...DEFAULT_ORIGINS];
				this._saveLists('allowedOrigins', this._origins);
				this._renderOriginsSection();
			}
		});
		footer.appendChild(resetBtn);

		container.appendChild(footer);
	}

	dispose(): void {
		this._container = null;
	}
}
