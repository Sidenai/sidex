/*---------------------------------------------------------------------------------------------
 *  Indexing section — fully connected to the Tauri index backend (no mocks).
 *
 *  Indexing is on-device BM25 by default (crates/sidex-agent/src/tools/context.rs)
 *  — nothing leaves the machine. A remote semantic index only augments search
 *  when the user has pointed SIDEX_CLOUD_API at a service of their own; there
 *  is no UI to configure it and no cloud service is reachable out of the box,
 *  so the description below must never promise cloud storage unconditionally.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { SidexChatService } from '../../sidexChatService.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface IndexStats {
	total_files: number;
	total_words: number;
	memory_bytes: number;
	root_path: string;
}

export class IndexingSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _workspacePath: string | null = null;
	private _disposables = new Set<() => void>();
	/** Whether SIDEX_CLOUD_API is set — the only thing that turns on remote augmentation. Re-read every render since it's an env var, not a setting. */
	private _cloudApiConfigured = false;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;

		// Listen for global indexing events ONCE in constructor
		const onIndexingEvent = () => {
			if (this._container) {
				this.render(this._container);
			}
		};
		window.addEventListener('sidex-indexing-status', onIndexingEvent);
		this._disposables.add(() => window.removeEventListener('sidex-indexing-status', onIndexingEvent));
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;
		
		// Clear everything synchronously before any awaits
		container.innerHTML = '';

		// Resolve workspace path from the chat service directly
		this._workspacePath = SidexChatService.INSTANCE?.workspacePath ?? null;

		if (this._invoke) {
			try {
				const cloudApi = await this._invoke('get_env', { key: 'SIDEX_CLOUD_API' }) as string | null;
				this._cloudApiConfigured = !!cloudApi;
			} catch { this._cloudApiConfigured = false; }
		}

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Indexing';
		container.appendChild(title);

		await this._renderStatsCard(container);
		
		// If the container was cleared by another render while we were awaiting, 
		// don't append the settings card to a dead DOM
		if (this._container && this._container.contains(title)) {
			this._renderSettingsCard(container);
		}
	}

	dispose(): void {
		this._disposables.forEach(d => d());
		this._disposables.clear();
		this._container = null;
	}

	private async _renderStatsCard(container: HTMLElement): Promise<void> {
		const hasWorkspace = this._workspacePath !== null;

		if (!hasWorkspace) {
			const card = document.createElement('div');
			card.className = 'sidex-settings-card';

			const emptyRow = document.createElement('div');
			emptyRow.style.cssText = 'padding: 24px 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; display: flex; flex-direction: column; align-items: center; gap: 6px;';

			const icon = document.createElement('span');
			icon.className = 'codicon codicon-info';
			icon.style.cssText = 'font-size: 20px; opacity: 0.8; margin-bottom: 2px;';
			emptyRow.appendChild(icon);

			const lbl = document.createElement('div');
			lbl.style.cssText = 'font-size: 13px; font-weight: 500; color: var(--vscode-foreground);';
			lbl.textContent = 'No Workspace Open';
			emptyRow.appendChild(lbl);

			const desc = document.createElement('div');
			desc.textContent = 'Open a folder (File > Open Folder) to index your codebase for fast search.';
			emptyRow.appendChild(desc);

			card.appendChild(emptyRow);
			container.appendChild(card);
			return;
		}

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		// Loading state
		const loading = document.createElement('div');
		loading.style.cssText = 'font-size:12px;padding:14px 20px;color:var(--vscode-descriptionForeground);';
		loading.textContent = 'Loading index stats…';
		card.appendChild(loading);
		container.appendChild(card);

		let stats: IndexStats | null = null;
		if (this._invoke && this._workspacePath) {
			try {
				stats = await this._invoke('index_stats') as IndexStats | null;
			} catch { /* no index yet */ }
		}

		loading.remove();

		const isIndexed = !!stats && stats.total_files > 0;

		// Check if indexing is currently running globally
		const isIndexingActive = SidexChatService.INSTANCE ? (SidexChatService.INSTANCE as any)._contextIndexing : false;

		if (!isIndexed) {
			// Not indexed yet
			const row1 = document.createElement('div');
			row1.className = 'sidex-settings-row';
			row1.style.cssText = 'flex-direction: column; align-items: stretch; padding: 14px 20px;';

			const header = document.createElement('div');
			header.style.cssText = 'font-size:14px;font-weight:500;margin-bottom:8px;display:flex;align-items:center;gap:6px;';
			header.innerHTML = `Codebase Indexing <span class="codicon codicon-question" style="font-size:12px;opacity:0.6;"></span>`;
			row1.appendChild(header);

			const desc = document.createElement('div');
			desc.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.4;margin-bottom:16px;';
			desc.textContent = this._indexingDescription();
			row1.appendChild(desc);

			const barOuter = document.createElement('div');
			barOuter.className = 'sidex-settings-progress';
			const barInner = document.createElement('div');
			barInner.className = 'sidex-settings-progress-bar';
			barInner.style.width = '0%';
			if (isIndexingActive) {
				barInner.style.width = '10%'; // show some progress
				// animate progress infinitely if active
				barInner.animate([
					{ backgroundPosition: '0% 0' },
					{ backgroundPosition: '200% 0' }
				], { duration: 1500, iterations: Infinity });
				barInner.style.background = 'linear-gradient(90deg, var(--vscode-button-background, #007fd4) 25%, #66b1ff 50%, var(--vscode-button-background, #007fd4) 75%)';
				barInner.style.backgroundSize = '200% 100%';
			}
			barOuter.appendChild(barInner);
			row1.appendChild(barOuter);

			const filesLabel = document.createElement('div');
			filesLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);';
			filesLabel.textContent = isIndexingActive ? 'Computing...' : '0 files';
			row1.appendChild(filesLabel);

			card.appendChild(row1);

			const row2 = document.createElement('div');
			row2.className = 'sidex-settings-row';
			row2.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 20px;min-height:48px;';
			
			const syncBtn = this._makeSyncBtn(card);
			syncBtn.innerHTML = `<span class="codicon codicon-sync ${isIndexingActive ? 'codicon-modifier-spin' : ''}"></span> ${isIndexingActive ? 'Indexing...' : 'Sync'}`;
			if (isIndexingActive) {
				syncBtn.disabled = true;
				syncBtn.style.opacity = '0.5';
			}
			row2.appendChild(syncBtn);

			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'sidex-settings-btn';
			deleteBtn.style.display = 'inline-flex';
			deleteBtn.style.alignItems = 'center';
			deleteBtn.style.gap = '6px';
			deleteBtn.innerHTML = `<span class="codicon codicon-trash"></span> Delete Index`;
			deleteBtn.disabled = true;
			deleteBtn.style.opacity = '0.5';
			row2.appendChild(deleteBtn);

			card.appendChild(row2);
		} else {
			// Indexed state
			const row1 = document.createElement('div');
			row1.className = 'sidex-settings-row';
			row1.style.cssText = 'flex-direction: column; align-items: stretch; padding: 14px 20px;';

			const header = document.createElement('div');
			header.style.cssText = 'font-size:14px;font-weight:500;margin-bottom:8px;display:flex;align-items:center;gap:6px;';
			header.innerHTML = `Codebase Indexing <span class="codicon codicon-question" style="font-size:12px;opacity:0.6;"></span>`;
			row1.appendChild(header);

			const desc = document.createElement('div');
			desc.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.4;margin-bottom:16px;';
			desc.textContent = this._indexingDescription();
			row1.appendChild(desc);

			const pctRow = document.createElement('div');
			pctRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px;';
			pctRow.innerHTML = `<span></span><span>100%</span>`;
			row1.appendChild(pctRow);

			const barOuter = document.createElement('div');
			barOuter.className = 'sidex-settings-progress';
			const barInner = document.createElement('div');
			barInner.className = 'sidex-settings-progress-bar';
			barInner.style.width = '100%';
			barOuter.appendChild(barInner);
			row1.appendChild(barOuter);

			const filesLabel = document.createElement('div');
			filesLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);';
			const fileCount = stats?.total_files ?? 0;
			filesLabel.textContent = `${fileCount.toLocaleString()} files`;
			row1.appendChild(filesLabel);

			card.appendChild(row1);

			const row2 = document.createElement('div');
			row2.className = 'sidex-settings-row';
			row2.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 20px;min-height:48px;';
			
			const syncBtn = this._makeSyncBtn(card);
			syncBtn.innerHTML = `<span class="codicon codicon-sync ${isIndexingActive ? 'codicon-modifier-spin' : ''}"></span> ${isIndexingActive ? 'Indexing...' : 'Sync'}`;
			if (isIndexingActive) {
				syncBtn.disabled = true;
				syncBtn.style.opacity = '0.5';
			}
			row2.appendChild(syncBtn);

			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'sidex-settings-btn';
			deleteBtn.style.display = 'inline-flex';
			deleteBtn.style.alignItems = 'center';
			deleteBtn.style.gap = '6px';
			deleteBtn.innerHTML = `<span class="codicon codicon-trash"></span> Delete Index`;
			deleteBtn.addEventListener('mouseover', () => { if (!deleteBtn.disabled) {deleteBtn.style.background = 'rgba(255,0,0,0.1)';} deleteBtn.style.borderColor = 'rgba(255,0,0,0.4)'; });
			deleteBtn.addEventListener('mouseout', () => { if (!deleteBtn.disabled) {deleteBtn.style.background = '';} deleteBtn.style.borderColor = ''; });
			deleteBtn.addEventListener('click', () => {
				if (!this._invoke) { return; }
				deleteBtn.disabled = true;
				deleteBtn.textContent = 'Deleting…';
				this._invoke('index_clear').then(() => {
					// Fire the event to reload the UI cleanly
					window.dispatchEvent(new CustomEvent('sidex-indexing-status', { 
						detail: { status: 'deleted', path: this._workspacePath } 
					}));
				}).catch(() => {
					deleteBtn.disabled = false;
					deleteBtn.innerHTML = `<span class="codicon codicon-trash"></span> Delete Index`;
				});
			});
			row2.appendChild(deleteBtn);

			card.appendChild(row2);
		}
	}

	private _indexingDescription(): string {
		return this._cloudApiConfigured
			? 'Your codebase is indexed on-device with BM25 keyword search, and results are augmented from the remote semantic index you\'ve configured via SIDEX_CLOUD_API. Search queries are sent there — your code itself never leaves this machine.'
			: 'Your codebase is indexed on-device with BM25 keyword search. Nothing leaves this machine — there is no cloud index configured.';
	}

	private _makeSyncBtn(_card: HTMLElement): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.className = 'sidex-settings-btn';
		btn.style.display = 'inline-flex';
		btn.style.alignItems = 'center';
		btn.style.gap = '6px';
		btn.innerHTML = `<span class="codicon codicon-sync"></span> Sync`;

		btn.addEventListener('mouseover', () => {
			if (!btn.disabled) {btn.style.background = 'var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31))';}
		});
		btn.addEventListener('mouseout', () => {
			if (!btn.disabled) {btn.style.background = '';}
		});
		
		btn.addEventListener('click', () => {
			if (!this._invoke || !this._workspacePath) { return; }
			
			// Fire the global event so other UI can update
			window.dispatchEvent(new CustomEvent('sidex-indexing-status', { 
				detail: { status: 'indexing', path: this._workspacePath } 
			}));

			this._invoke('index_build', { root: this._workspacePath }).then(() => {
				// index_build resolves once the on-device index is written.
				// The Rust backend will emit the real 'done' event when the cloud finishes!
			}).catch((err) => {
				console.error('[sidex-index] Build failed:', err);
				window.dispatchEvent(new CustomEvent('sidex-indexing-status', { 
					detail: { status: 'error', path: this._workspacePath, error: err } 
				}));
			});
		});
		return btn;
	}

	private _renderSettingsCard(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		this._addToggleRow(card,
			'Auto-index new folders',
			'Automatically re-index when files change',
			'sidex.indexing.autoIndex',
			true
		);

		this._addToggleRow(card,
			'Respect .gitignore',
			'Skip files and directories listed in .gitignore',
			'sidex.indexing.respectGitignore',
			true
		);

		this._addToggleRow(card,
			'Instant grep',
			'Use the local index for fast grep across the codebase',
			'sidex.indexing.instantGrep',
			true
		);

		container.appendChild(card);
	}

	private _addToggleRow(
		parent: HTMLElement,
		label: string,
		desc: string,
		key: string,
		defaultOn: boolean
	): void {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.className = 'sidex-settings-row-label';
		lbl.textContent = label;
		left.appendChild(lbl);
		const descEl = document.createElement('div');
		descEl.className = 'sidex-settings-row-description';
		descEl.textContent = desc;
		left.appendChild(descEl);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (defaultOn ? ' on' : '');

		if (this._invoke) {
			this._invoke('settings_get', { section: key }).then((val) => {
				if (val === true) { toggle.classList.add('on'); }
				else if (val === false) { toggle.classList.remove('on'); }
			}).catch(() => {});
		}

		toggle.addEventListener('click', () => {
			toggle.classList.toggle('on');
			if (this._invoke) {
				this._invoke('settings_update', {
					key,
					value: JSON.stringify(toggle.classList.contains('on')),
					scope: 'user',
				}).catch(() => {});
			}
		});

		action.appendChild(toggle);
		row.appendChild(action);
		parent.appendChild(row);
	}
}
