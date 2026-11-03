/*---------------------------------------------------------------------------------------------
 *  Hooks section for SideX Settings panel.
 *  Manage lifecycle hooks that trigger automated actions on agent events.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface HookItem {
	id: string;
	event: string;
	actionType: 'shell_command' | 'script';
	command: string;
	enabled: boolean;
}

const HOOK_EVENTS = [
	'on_file_save',
	'on_commit',
	'on_agent_start',
	'on_agent_end',
	'before_tool_call',
];

const EVENT_LABELS: Record<string, string> = {
	on_file_save: 'On File Save',
	on_commit: 'On Commit',
	on_agent_start: 'On Agent Start',
	on_agent_end: 'On Agent End',
	before_tool_call: 'Before Tool Call',
};

export class HooksSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _hooks: HookItem[] = [];
	private _addFormVisible = false;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Hooks';
		container.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.style.marginBottom = '16px';
		desc.textContent = 'Automate actions triggered by agent lifecycle events';
		container.appendChild(desc);

		await this._loadHooks();
		this._renderAddButton(container);
		this._renderAddForm(container);
		this._renderHookList(container);
	}

	private async _loadHooks(): Promise<void> {
		if (!this._invoke) { return; }
		try {
			const data = await this._invoke('hooks_list') as HookItem[] | null;
			if (data) { this._hooks = data; }
		} catch { /* use empty */ }
	}

	private _renderAddButton(container: HTMLElement): void {
		const wrapper = document.createElement('div');
		wrapper.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:12px;';

		const btn = document.createElement('button');
		btn.className = 'sidex-settings-btn sidex-settings-btn-primary';
		btn.textContent = '+ Add Hook';
		btn.addEventListener('click', () => this._toggleAddForm());
		wrapper.appendChild(btn);

		container.appendChild(wrapper);
	}

	private _renderAddForm(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.dataset.role = 'hook-add-form';
		card.style.display = this._addFormVisible ? '' : 'none';

		// Event dropdown
		const eventRow = document.createElement('div');
		eventRow.className = 'sidex-settings-row';
		const eventLeft = document.createElement('div');
		const eventLabel = document.createElement('div');
		eventLabel.className = 'sidex-settings-row-label';
		eventLabel.textContent = 'Event Trigger';
		eventLeft.appendChild(eventLabel);
		eventRow.appendChild(eventLeft);

		const eventAction = document.createElement('div');
		eventAction.className = 'sidex-settings-row-action';
		const eventOptions = HOOK_EVENTS.map(evt => ({
			value: evt,
			label: EVENT_LABELS[evt] || evt
		}));
		const eventSelect = createCustomDropdown(eventOptions, HOOK_EVENTS[0], () => {});
		eventSelect.dataset.field = 'event';
		eventAction.appendChild(eventSelect);
		eventRow.appendChild(eventAction);
		card.appendChild(eventRow);

		// Action type dropdown
		const typeRow = document.createElement('div');
		typeRow.className = 'sidex-settings-row';
		const typeLeft = document.createElement('div');
		const typeLabel = document.createElement('div');
		typeLabel.className = 'sidex-settings-row-label';
		typeLabel.textContent = 'Action Type';
		typeLeft.appendChild(typeLabel);
		typeRow.appendChild(typeLeft);

		const typeAction = document.createElement('div');
		typeAction.className = 'sidex-settings-row-action';
		const typeOptions = [
			{ value: 'shell_command', label: 'Shell Command' },
			{ value: 'script', label: 'Script' }
		];
		const typeSelect = createCustomDropdown(typeOptions, 'shell_command', () => {});
		typeSelect.dataset.field = 'actionType';
		typeAction.appendChild(typeSelect);
		typeRow.appendChild(typeAction);
		card.appendChild(typeRow);

		// Command input
		const cmdRow = document.createElement('div');
		cmdRow.className = 'sidex-settings-row';
		const cmdLeft = document.createElement('div');
		const cmdLabel = document.createElement('div');
		cmdLabel.className = 'sidex-settings-row-label';
		cmdLabel.textContent = 'Command';
		cmdLeft.appendChild(cmdLabel);
		cmdRow.appendChild(cmdLeft);

		const cmdAction = document.createElement('div');
		cmdAction.className = 'sidex-settings-row-action';
		const cmdWrapper = document.createElement('div');
		cmdWrapper.className = 'sidex-input-wrapper';
		cmdWrapper.style.width = '220px';
		const cmdInput = document.createElement('input');
		cmdInput.type = 'text';
		cmdInput.placeholder = 'npm run lint --fix';
		cmdInput.dataset.field = 'command';
		cmdWrapper.appendChild(cmdInput);
		cmdAction.appendChild(cmdWrapper);
		cmdRow.appendChild(cmdAction);
		card.appendChild(cmdRow);

		// Buttons
		const btnRow = document.createElement('div');
		btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding-top:8px;';

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'sidex-settings-btn';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', () => this._toggleAddForm());
		btnRow.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.className = 'sidex-settings-btn sidex-settings-btn-primary';
		saveBtn.textContent = 'Save Hook';
		saveBtn.addEventListener('click', () => this._submitNewHook(card));
		btnRow.appendChild(saveBtn);

		card.appendChild(btnRow);
		container.appendChild(card);
	}

	private _renderHookList(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		if (this._hooks.length === 0) {
			const empty = document.createElement('div');
			empty.style.cssText = 'padding:24px;text-align:center;';

			const emptyLabel = document.createElement('div');
			emptyLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:12px;';
			emptyLabel.textContent = 'No hooks configured yet.';
			empty.appendChild(emptyLabel);

			const newBtn = document.createElement('button');
			newBtn.className = 'sidex-settings-btn';
			newBtn.textContent = 'New Hook';
			newBtn.addEventListener('click', () => this._toggleAddForm());
			empty.appendChild(newBtn);

			card.appendChild(empty);
		} else {
			for (const hook of this._hooks) {
				const row = document.createElement('div');
				row.className = 'sidex-settings-row';

				const left = document.createElement('div');
				const nameEl = document.createElement('div');
				nameEl.className = 'sidex-settings-row-label';
				nameEl.textContent = EVENT_LABELS[hook.event] || hook.event;
				left.appendChild(nameEl);

				const descEl = document.createElement('div');
				descEl.className = 'sidex-settings-row-description';
				descEl.textContent = `${hook.actionType === 'shell_command' ? 'Shell' : 'Script'}: ${hook.command}`;
				left.appendChild(descEl);
				row.appendChild(left);

				const action = document.createElement('div');
				action.className = 'sidex-settings-row-action';
				action.style.cssText = 'display:flex;align-items:center;gap:8px;';

				const toggle = document.createElement('div');
				toggle.className = 'sidex-settings-toggle' + (hook.enabled ? ' on' : '');
				toggle.addEventListener('click', () => {
					toggle.classList.toggle('on');
					if (this._invoke) {
						this._invoke('hooks_toggle', { id: hook.id }).catch(() => {});
					}
				});
				action.appendChild(toggle);

				const removeBtn = document.createElement('span');
				removeBtn.className = 'codicon codicon-trash';
				removeBtn.style.cssText = 'cursor:pointer;color:var(--vscode-descriptionForeground);';
				removeBtn.title = 'Remove hook';
				removeBtn.addEventListener('click', () => {
					if (this._invoke) {
						this._invoke('hooks_remove', { id: hook.id }).then(() => {
							if (this._container) {
								this._container.innerHTML = '';
								this.render(this._container);
							}
						}).catch(() => {});
					}
				});
				action.appendChild(removeBtn);

				row.appendChild(action);
				card.appendChild(row);
			}
		}

		container.appendChild(card);
	}

	private _toggleAddForm(): void {
		if (!this._container) { return; }
		const form = this._container.querySelector('[data-role="hook-add-form"]') as HTMLElement | null;
		if (!form) { return; }
		this._addFormVisible = !this._addFormVisible;
		form.style.display = this._addFormVisible ? '' : 'none';
	}

	private _submitNewHook(formCard: HTMLElement): void {
		const eventSelect = formCard.querySelector('[data-field="event"]') as HTMLSelectElement;
		const typeSelect = formCard.querySelector('[data-field="actionType"]') as HTMLSelectElement;
		const cmdInput = formCard.querySelector('[data-field="command"]') as HTMLInputElement;

		const event = eventSelect?.value;
		const action = typeSelect?.value;
		const command = cmdInput?.value.trim();

		if (!event || !command) { return; }

		if (this._invoke) {
			this._invoke('hooks_add', {
				event,
				action,
				command,
				enabled: true,
			}).then(() => {
				if (this._container) {
					this._container.innerHTML = '';
					this.render(this._container);
				}
			}).catch(() => {});
		}
	}

	dispose(): void {
		this._container = null;
	}
}
