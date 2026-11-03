/*---------------------------------------------------------------------------------------------
 *  Cloud Agents section for SideX Settings panel.
 *
 *  This used to render a "Cloud Agents" feature — an enable toggle gated on
 *  "Pro+ plans", a remote environment picker, a timeout, and auto-assignment
 *  — modeled on Cursor's hosted background-agent service. SideX has no
 *  account, no plans, and no hosted infrastructure to run agents on: there
 *  is no Tauri command or HTTP endpoint anywhere in this app that executes a
 *  task remotely, and nothing reads the sidex.cloudAgents.* settings this
 *  section used to write — they were persisted and never consumed. Shipping
 *  those controls would let someone "enable" a feature that silently does
 *  nothing.
 *
 *  Rather than fake a working panel, this section says plainly that agents
 *  only ever run locally and points at where models are actually
 *  configured. If a real remote-execution backend is added later, this is
 *  the file to bring the settings back into.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

export class CloudAgentsSection implements SettingsSection {
	private _container: HTMLElement | null = null;

	// Accepted for constructor-shape parity with every other section (they're
	// all built as `new XSection(this._getTauriInvoke())`) even though there
	// is nothing here to fetch or save.
	constructor(_invoke: TauriInvoke) { }

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Cloud Agents';
		container.appendChild(title);

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const infoCol = document.createElement('div');
		infoCol.style.cssText = 'display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1;padding-right:16px;';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-info';
		icon.style.cssText = 'font-size:16px;color:var(--vscode-descriptionForeground);flex-shrink:0;margin-top:2px;';
		infoCol.appendChild(icon);

		const text = document.createElement('div');
		text.style.cssText = 'font-size:12px;color:var(--vscode-editor-foreground);line-height:1.5;';
		text.textContent = 'SideX has no hosted infrastructure to run agents on — there\'s no remote environment, timeout, or queue to configure here. Every agent runs on this machine, using whichever providers and models you\'ve set up under Models.';
		infoCol.appendChild(text);

		row.appendChild(infoCol);

		const configureBtn = document.createElement('button');
		configureBtn.className = 'sidex-settings-btn';
		configureBtn.style.flexShrink = '0';
		configureBtn.textContent = 'Configure Models';
		configureBtn.addEventListener('click', () => {
			window.dispatchEvent(new CustomEvent('sidex-settings-navigate', { detail: 'models' }));
		});
		row.appendChild(configureBtn);

		card.appendChild(row);
		container.appendChild(card);
	}

	dispose(): void {
		this._container = null;
	}
}
