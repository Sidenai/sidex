/*---------------------------------------------------------------------------------------------
 *  Beta section for SideX Settings panel.
 *  Update channel selection and experimental feature toggles.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

export class BetaSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Beta';
		container.appendChild(title);

		this._renderUpdateAccess(container);
		this._renderExtensionRpcTracer(container);
	}

	private _renderUpdateAccess(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.textContent = 'Update Access';
		left.appendChild(label);
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'By default, get notifications for stable updates. In Early Access, pre-release builds may be unstable for production work.';
		left.appendChild(desc);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		const dropdown = createCustomDropdown(['Default', 'Early Access'], 'Default', (newValue) => {
			if (this._invoke) {
				this._invoke('settings_update', { key: 'sidex.beta.updateChannel', value: JSON.stringify(newValue), scope: 'user' }).catch(() => {});
			}
		});

		if (this._invoke) {
			this._invoke('settings_get', { section: 'sidex.beta.updateChannel' }).then((val) => {
				if (val && typeof val === 'string') { (dropdown as any).setValue(val); }
			}).catch(() => {});
		}

		action.appendChild(dropdown);
		row.appendChild(action);
		card.appendChild(row);
		container.appendChild(card);
	}

	private _renderExtensionRpcTracer(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.marginTop = '12px';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.textContent = 'Extension RPC Tracer';
		left.appendChild(label);
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'Log extension host RPC messages to JSON files viewable in Perfetto for performance analysis. Requires a restart to take effect.';
		left.appendChild(desc);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';

		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle';

		if (this._invoke) {
			this._invoke('settings_get', { section: 'sidex.beta.rpcTracer' }).then((val) => {
				if (val === true) {
					toggle.classList.add('on');
				}
			}).catch(() => {});
		}

		toggle.addEventListener('click', () => {
			toggle.classList.toggle('on');
			if (this._invoke) {
				const nowOn = toggle.classList.contains('on');
				this._invoke('settings_update', { key: 'sidex.beta.rpcTracer', value: JSON.stringify(nowOn), scope: 'user' }).catch(() => {});
			}
		});
		action.appendChild(toggle);
		row.appendChild(action);

		card.appendChild(row);
		container.appendChild(card);
	}

	dispose(): void {
		this._container = null;
	}
}
