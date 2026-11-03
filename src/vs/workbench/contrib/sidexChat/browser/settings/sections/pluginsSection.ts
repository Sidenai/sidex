/*---------------------------------------------------------------------------------------------
 *  Plugins section for SideX Settings panel.
 *  Browser automation settings and installed MCP server management.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface McpServer {
	name: string;
	status: 'running' | 'stopped' | 'error';
	toolCount: number;
	enabled: boolean;
}

export class PluginsSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _mcpListEl: HTMLElement | null = null;
	private _addFormVisible = false;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Plugins';
		container.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.style.marginBottom = '16px';
		desc.textContent = 'Extend SideX with community plugins';
		container.appendChild(desc);

		this._renderBrowserSection(container);
		await this._renderMcpSection(container);
	}

	private _renderBrowserSection(container: HTMLElement): void {
		const sectionTitle = document.createElement('div');
		sectionTitle.className = 'sidex-settings-section-title';
		sectionTitle.textContent = 'Browser';
		sectionTitle.style.marginTop = '24px';
		container.appendChild(sectionTitle);

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const autoRow = this._createRow(card, 'Browser Automation', 'Choose browser automation framework');
		this._addSelect(autoRow, ['Off', 'Playwright', 'Puppeteer'], 'Off', 'sidex.plugins.browserAutomation');

		const localhostRow = this._createRow(card, 'Show Localhost Links in Browser', 'Auto open localhost links detected in output');
		this._addToggle(localhostRow, true, 'sidex.plugins.showLocalhostLinks');

		container.appendChild(card);
	}

	private async _renderMcpSection(container: HTMLElement): Promise<void> {
		const sectionHeader = document.createElement('div');
		sectionHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:24px;';

		const sectionTitle = document.createElement('div');
		sectionTitle.className = 'sidex-settings-section-title';
		sectionTitle.style.margin = '0';
		sectionTitle.textContent = 'Installed MCP Servers';
		sectionHeader.appendChild(sectionTitle);

		const addBtn = document.createElement('button');
		addBtn.className = 'sidex-settings-btn sidex-settings-btn-primary';
		addBtn.textContent = '+ New MCP Server';
		addBtn.addEventListener('click', () => this._toggleAddForm());
		sectionHeader.appendChild(addBtn);

		container.appendChild(sectionHeader);

		const formCard = document.createElement('div');
		formCard.className = 'sidex-settings-card sidex-settings-mcp-form';
		formCard.style.display = 'none';
		formCard.dataset.role = 'mcp-add-form';

		this._buildAddForm(formCard);
		container.appendChild(formCard);

		this._mcpListEl = document.createElement('div');
		this._mcpListEl.className = 'sidex-settings-card';
		container.appendChild(this._mcpListEl);

		let servers: McpServer[] = [];
		if (this._invoke) {
			try {
				const data = await this._invoke('mcp_list_servers') as McpServer[] | null;
				if (data) { servers = data; }
			} catch { /* use empty */ }
		}

		this._renderServerList(servers);
	}

	private _renderServerList(servers: McpServer[]): void {
		if (!this._mcpListEl) { return; }
		this._mcpListEl.innerHTML = '';

		if (servers.length === 0) {
			const empty = document.createElement('div');
			empty.style.cssText = 'padding:16px;font-size:12px;color:var(--vscode-descriptionForeground);text-align:center;';
			empty.textContent = 'No MCP servers installed. Click "New MCP Server" to add one.';
			this._mcpListEl.appendChild(empty);
			return;
		}

		for (const server of servers) {
			const item = document.createElement('div');
			item.className = 'sidex-settings-row';

			const left = document.createElement('div');
			left.style.cssText = 'display:flex;align-items:center;gap:8px;';

			const statusDot = document.createElement('span');
			statusDot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${server.status === 'running' ? 'var(--vscode-testing-iconPassed)' : server.status === 'error' ? 'var(--vscode-testing-iconFailed)' : 'var(--vscode-descriptionForeground)'};`;
			left.appendChild(statusDot);

			const info = document.createElement('div');
			const nameEl = document.createElement('div');
			nameEl.className = 'sidex-settings-row-label';
			nameEl.textContent = server.name;
			info.appendChild(nameEl);

			const toolsEl = document.createElement('div');
			toolsEl.className = 'sidex-settings-row-description';
			toolsEl.textContent = `${server.toolCount} tool${server.toolCount !== 1 ? 's' : ''} · ${server.status}`;
			info.appendChild(toolsEl);
			left.appendChild(info);

			item.appendChild(left);

			const action = document.createElement('div');
			action.className = 'sidex-settings-row-action';
			action.style.cssText = 'display:flex;align-items:center;gap:8px;';

			const toggle = document.createElement('div');
			toggle.className = 'sidex-settings-toggle' + (server.enabled ? ' on' : '');
			toggle.addEventListener('click', () => {
				toggle.classList.toggle('on');
				const enabled = toggle.classList.contains('on');
				if (this._invoke) {
					const cmd = enabled ? 'mcp_connect' : 'mcp_disconnect';
					this._invoke(cmd, { name: server.name }).catch(() => {});
				}
			});
			action.appendChild(toggle);

			const removeBtn = document.createElement('span');
			removeBtn.className = 'codicon codicon-trash';
			removeBtn.style.cssText = 'cursor:pointer;color:var(--vscode-descriptionForeground);';
			removeBtn.title = 'Remove server';
			removeBtn.addEventListener('click', () => {
				if (this._invoke) {
					this._invoke('mcp_remove_server', { name: server.name }).then(() => {
						if (this._container) {
							this._container.innerHTML = '';
							this.render(this._container);
						}
					}).catch(() => {});
				}
			});
			action.appendChild(removeBtn);

			item.appendChild(action);
			this._mcpListEl.appendChild(item);
		}
	}

	private _buildAddForm(formCard: HTMLElement): void {
		const fields = [
			{ label: 'Server Name', placeholder: 'my-server', key: 'name' },
			{ label: 'Command', placeholder: 'npx -y @modelcontextprotocol/server-...', key: 'command' },
			{ label: 'Arguments', placeholder: '--port 3000', key: 'args' },
		];

		for (const field of fields) {
			const row = document.createElement('div');
			row.className = 'sidex-settings-row';

			const left = document.createElement('div');
			const label = document.createElement('div');
			label.className = 'sidex-settings-row-label';
			label.textContent = field.label;
			left.appendChild(label);
			row.appendChild(left);

			const action = document.createElement('div');
			action.className = 'sidex-settings-row-action';
			const wrapper = document.createElement('div');
			wrapper.className = 'sidex-input-wrapper';
			wrapper.style.width = '220px';
			const input = document.createElement('input');
			input.type = 'text';
			input.placeholder = field.placeholder;
			input.dataset.field = field.key;
			wrapper.appendChild(input);
			action.appendChild(wrapper);
			row.appendChild(action);

			formCard.appendChild(row);
		}

		const btnRow = document.createElement('div');
		btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding-top:8px;';

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'sidex-settings-btn';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', () => this._toggleAddForm());
		btnRow.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.className = 'sidex-settings-btn sidex-settings-btn-primary';
		saveBtn.textContent = 'Add Server';
		saveBtn.addEventListener('click', () => this._submitNewServer(formCard));
		btnRow.appendChild(saveBtn);

		formCard.appendChild(btnRow);
	}

	private _toggleAddForm(): void {
		if (!this._container) { return; }
		const form = this._container.querySelector('[data-role="mcp-add-form"]') as HTMLElement | null;
		if (!form) { return; }
		this._addFormVisible = !this._addFormVisible;
		form.style.display = this._addFormVisible ? '' : 'none';
	}

	private _submitNewServer(formCard: HTMLElement): void {
		const inputs = formCard.querySelectorAll('input[data-field]');
		const values: Record<string, string> = {};
		inputs.forEach(input => {
			const el = input as HTMLInputElement;
			values[el.dataset.field!] = el.value.trim();
		});

		if (!values.name || !values.command) { return; }

		if (this._invoke) {
			this._invoke('mcp_add_server', {
				name: values.name,
				command: values.command,
				args: values.args || '',
			}).then(() => {
				if (this._container) {
					this._container.innerHTML = '';
					this.render(this._container);
				}
			}).catch(() => {});
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

		if (this._invoke) {
			this._invoke('settings_get', { section: settingKey }).then((val) => {
				if (val === true) { toggle.classList.add('on'); }
				else if (val === false) { toggle.classList.remove('on'); }
			}).catch(() => {});
		}

		toggle.addEventListener('click', () => {
			toggle.classList.toggle('on');
			const value = toggle.classList.contains('on');
			if (this._invoke) {
				this._invoke('settings_update', { key: settingKey, value: JSON.stringify(value), scope: 'user' }).catch(() => {});
			}
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(toggle);
		return toggle;
	}

	private _addSelect(row: HTMLElement, options: string[], defaultValue: string, settingKey: string): HTMLElement {
		const dropdown = createCustomDropdown(options, defaultValue, (newValue) => {
			if (this._invoke) {
				this._invoke('settings_update', { key: settingKey, value: JSON.stringify(newValue), scope: 'user' }).catch(() => {});
			}
		});

		if (this._invoke) {
			this._invoke('settings_get', { section: settingKey }).then((val) => {
				if (val && typeof val === 'string') { (dropdown as any).setValue(val); }
			}).catch(() => {});
		}

		row.querySelector('.sidex-settings-row-action')!.appendChild(dropdown);
		return dropdown;
	}

	dispose(): void {
		this._container = null;
		this._mcpListEl = null;
	}
}
