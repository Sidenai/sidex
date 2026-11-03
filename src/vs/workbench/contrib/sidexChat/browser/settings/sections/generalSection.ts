/*---------------------------------------------------------------------------------------------
 *  General section for SideX Settings panel.
 *  Renders using VS Code settings-editor row structure for 1:1 parity.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface SettingsData {
	[key: string]: unknown;
}

interface ModelOption {
	value: string;
	label: string;
}

export class GeneralSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _settings: SettingsData = {};
	private _modelOptions: ModelOption[] = [];

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		if (this._invoke) {
			try {
				const data = await this._invoke('settings_get', { section: 'sidex.general' }) as SettingsData | null;
				if (data) { this._settings = data; }
			} catch { /* use defaults */ }
			await this._loadModelOptions();
		}

		this._createSectionTitle(container, 'General');

		const card = this._createCard(container);

		// 1. Default Model
		this._addDefaultModelRow(card);

		// 2. Default Agent Mode
		this._addSelectRow(
			card,
			'Default Agent Mode',
			'Set the default agent capability when starting a new workspace task.',
			[
				{ value: 'agent', label: 'Agent' },
				{ value: 'plan', label: 'Plan' },
				{ value: 'ask', label: 'Ask' }
			],
			this._getSetting('defaultAgent', 'agent') as string,
			'sidex.general.defaultAgent'
		);

		// 3. Auto Scroll
		this._addToggleRow(
			card,
			'Auto scroll on message',
			'Automatically scroll the conversation viewport down when a new message is received.',
			'sidex.general.autoScroll',
			this._getSetting('autoScroll', true) as boolean
		);
	}

	public renderPreferences(container: HTMLElement): void {
		this._renderPreferences(container);
	}

	public renderLayout(container: HTMLElement): void {
		this._renderLayout(container);
	}

	public renderNotifications(container: HTMLElement): void {
		this._renderNotifications(container);
	}

	public renderPrivacy(container: HTMLElement): void {
		this._renderPrivacy(container);
	}

	private _renderPreferences(container: HTMLElement): void {
		this._createSectionTitle(container, 'Preferences');
		const card = this._createCard(container);

		const editorRow = this._createRow(card, 'Editor Settings', 'Customize editor appearance and behavior');
		this._addButton(editorRow, 'Open', () => {
			window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: 'settings' }));
		});

		const kbRow = this._createRow(card, 'Keyboard Shortcuts', 'Customize keybindings');
		this._addButton(kbRow, 'Open', () => {
			window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: 'keybindings' }));
		});

		const importRow = this._createRow(card, 'Import Settings from VS Code', 'Import your existing configuration');
		this._addButton(importRow, 'Import', () => {
			this._showToast('Coming soon — VS Code settings import is not yet available.');
		});

		const resetRow = this._createRow(card, 'Reset Don\'t Ask Again Dialogs', 'Show previously dismissed dialogs');
		this._addButton(resetRow, 'Show', () => {
			if (this._invoke) {
				this._invoke('settings_update', { key: 'sidex.general.dismissedDialogs', value: JSON.stringify({}), scope: 'user' }).then(() => {
					this._showToast('All dialogs have been reset.');
				}).catch(() => {});
			}
		});
	}

	private _renderLayout(container: HTMLElement): void {
		this._createSectionTitle(container, 'Layout');
		const card = this._createCard(container);

		this._addSelectRow(card, 'Window Layout', 'Choose default window arrangement',
			['Editor', 'Agent'], this._getSetting('windowLayout', 'Editor') as string, 'sidex.general.windowLayout');

		this._addSelectRow(card, 'Conversation Density', 'Adjust chat message spacing',
			['Compact', 'Comfortable', 'Spacious'], this._getSetting('conversationDensity', 'Comfortable') as string, 'sidex.general.conversationDensity');

		this._addToggleRow(card, 'Title Bar', 'Show the window title bar',
			'sidex.general.titleBar', this._getSetting('titleBar', true) as boolean);

		this._addToggleRow(card, 'Status Bar', 'Show the status bar at the bottom',
			'sidex.general.statusBar', this._getSetting('statusBar', true) as boolean);

		this._addSelectRow(card, 'Review Control Location', 'Where to show review controls',
			['Gutter', 'Toolbar', 'Both'], this._getSetting('reviewControlLocation', 'Gutter') as string, 'sidex.general.reviewControlLocation');

		this._addToggleRow(card, 'Auto-hide editor when empty', 'Collapse editor panel if no tabs are open',
			'sidex.general.autoHideEditor', this._getSetting('autoHideEditor', false) as boolean);

		const tabsRow = this._addToggleRow(card, 'Open chat as editor tabs', '',
			'sidex.general.chatAsTabs', this._getSetting('chatAsTabs', false) as boolean);
		const badge = document.createElement('span');
		badge.className = 'sidex-settings-new-badge';
		badge.textContent = 'NEW';
		tabsRow.querySelector('.sidex-settings-row-label')!.appendChild(badge);
	}

	private _renderNotifications(container: HTMLElement): void {
		this._createSectionTitle(container, 'Notifications');
		const card = this._createCard(container);

		this._addToggleRow(card, 'System Notifications', 'Show OS-level notifications',
			'sidex.general.systemNotifications', this._getSetting('systemNotifications', true) as boolean);

		this._addToggleRow(card, 'Menu Bar Icon', 'Show icon in the system tray/menu bar',
			'sidex.general.menuBarIcon', this._getSetting('menuBarIcon', true) as boolean);

		this._addToggleRow(card, 'Completion Sound', 'Play a sound when operations complete',
			'sidex.general.completionSound', this._getSetting('completionSound', false) as boolean);
	}

	private _renderPrivacy(container: HTMLElement): void {
		this._createSectionTitle(container, 'Privacy');
		const card = this._createCard(container);
		this._addToggleRow(card,
			'Data Sharing',
			'Help improve SideX by sharing anonymous usage data. No code or personal information is ever collected.',
			'sidex.general.dataSharing', this._getSetting('dataSharing', true) as boolean);
	}



	/**
	 * There is no curated model catalog anymore (see ModelsSection) — a
	 * default can only be one of the models the user has actually added,
	 * so this reads the same 'sidex.models.custom' list that section owns
	 * rather than hardcoding a preset.
	 */
	private async _loadModelOptions(): Promise<void> {
		if (!this._invoke) { return; }
		try {
			const raw = await this._invoke('settings_get', { section: 'sidex.models.custom' });
			const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
			if (!Array.isArray(arr)) { return; }
			this._modelOptions = arr
				.map((entry: string | { id?: string; name?: string }) => {
					const id = typeof entry === 'string' ? entry : entry?.id;
					if (!id) { return null; }
					const name = typeof entry === 'object' ? entry?.name : undefined;
					return { value: id, label: name ? `${name} (${id})` : id };
				})
				.filter((opt): opt is ModelOption => opt !== null);
		} catch { /* no models configured yet */ }
	}

	private _addDefaultModelRow(card: HTMLElement): void {
		if (this._modelOptions.length === 0) {
			// Nothing to default to until the user adds a model — a dropdown
			// with no real entries would look broken rather than empty.
			const row = this._createRow(card, 'Default AI Model', 'Add a model in the Models section to set a default for new conversations.');
			this._addButton(row, 'Configure Models', () => {
				window.dispatchEvent(new CustomEvent('sidex-settings-navigate', { detail: 'models' }));
			});
			return;
		}

		// A blank saved value means "no override" — represent that as its own
		// option instead of silently defaulting the dropdown to whichever
		// model happens to be first, which would look chosen without being saved.
		const options: ModelOption[] = [{ value: '', label: 'No default (use first available)' }, ...this._modelOptions];
		this._addSelectRow(
			card,
			'Default AI Model',
			'Select which AI model new conversations will start with by default.',
			options,
			this._getSetting('defaultModel', '') as string,
			'sidex.general.defaultModel'
		);
	}

	// --- Helpers ---

	private _getSetting(key: string, defaultValue: unknown): unknown {
		return this._settings[key] ?? defaultValue;
	}

	private _saveSetting(key: string, value: unknown): void {
		if (!this._invoke) { return; }
		this._invoke('settings_update', { key, value: JSON.stringify(value), scope: 'user' }).then(() => {
			window.dispatchEvent(new CustomEvent('sidex-settings-changed'));
		}).catch(() => {});
	}

	private _showToast(message: string): void {
		const existing = document.querySelector('.sidex-settings-toast');
		if (existing) { existing.remove(); }

		const toast = document.createElement('div');
		toast.className = 'sidex-settings-toast';
		toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:6px;font-size:12px;z-index:10000;';
		toast.style.background = 'var(--vscode-notifications-background)';
		toast.style.color = 'var(--vscode-notifications-foreground)';
		toast.style.border = '1px solid var(--vscode-widget-border)';
		toast.style.boxShadow = 'var(--vscode-shadow-xl)';
		toast.textContent = message;
		document.body.appendChild(toast);
		setTimeout(() => toast.remove(), 3000);
	}

	private _createSectionTitle(parent: HTMLElement, text: string): void {
		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = text;
		parent.appendChild(title);
	}

	private _createCard(parent: HTMLElement): HTMLElement {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		parent.appendChild(card);
		return card;
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

	private _addButton(row: HTMLElement, text: string, onClick: () => void): void {
		const btn = document.createElement('button');
		btn.className = 'sidex-settings-btn';
		btn.textContent = text;
		btn.addEventListener('click', onClick);
		row.querySelector('.sidex-settings-row-action')!.appendChild(btn);
	}

	private _addToggleRow(parent: HTMLElement, label: string, description: string, settingKey: string, initialState: boolean): HTMLElement {
		const row = this._createRow(parent, label, description);
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (initialState ? ' on' : '');
		toggle.setAttribute('role', 'checkbox');
		toggle.setAttribute('aria-checked', String(initialState));
		toggle.setAttribute('aria-label', label);
		toggle.tabIndex = 0;
		toggle.addEventListener('click', () => {
			const isOn = toggle.classList.toggle('on');
			toggle.setAttribute('aria-checked', String(isOn));
			this._saveSetting(settingKey, isOn);
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(toggle);
		return row;
	}

	private _addSelectRow(parent: HTMLElement, label: string, description: string, options: any[], currentValue: string, settingKey: string): HTMLElement {
		const row = this._createRow(parent, label, description);
		const dropdown = createCustomDropdown(options, currentValue, (newValue) => {
			this._saveSetting(settingKey, newValue);
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(dropdown);
		return row;
	}

	dispose(): void {
		this._container = null;
	}
}
