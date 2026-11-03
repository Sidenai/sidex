/*---------------------------------------------------------------------------------------------
 *  Network section for SideX Settings panel.
 *  HTTP mode, required domains, and network diagnostics.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';
import { resolveServerEndpoint } from '../../localServer.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

/** Subset of `providers_status`'s return shape (see `providers.rs`) that this section needs. */
interface ProviderStatusInfo {
	baseUrl: string;
	configured: boolean;
	enabled: boolean;
}

/**
 * SideX has no account, no hosted app, and no telemetry, so there is no
 * fixed backend to allowlist. What's left are the two external services
 * that exist regardless of which AI provider the user picks:
 *   - the extension marketplace proxy (`extensionsGallery.serviceUrl` in
 *     `src/vs/platform/product/common/product.ts`, backed by Open VSX)
 *   - the auto-update feed (`plugins.updater.endpoints` in
 *     `src-tauri/tauri.conf.json`)
 * Keep these in sync with those files if either endpoint moves.
 */
const FIXED_DOMAINS = [
	'marketplace.siden.ai',
	'cdn.siden.ai',
];

function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export class NetworkSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _domainsVisible: boolean = false;
	/** Hostnames of whichever AI providers the user has configured and enabled. Empty until `render()` resolves. */
	private _providerDomains: string[] = [];

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		if (this._invoke) {
			try {
				const statuses = await this._invoke('providers_status') as ProviderStatusInfo[] | null;
				this._providerDomains = Array.from(new Set((statuses ?? [])
					.filter(s => s.enabled && s.configured)
					.map(s => { try { return new URL(s.baseUrl).hostname; } catch { return null; } })
					.filter((host): host is string => !!host && !isLoopbackHost(host))));
			} catch { /* provider list unavailable; the domain list just omits it */ }
		}

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Network';
		container.appendChild(title);

		this._renderHttpMode(container);
		this._renderRequiredDomains(container);
		this._renderDiagnostics(container);
	}

	private _renderHttpMode(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.textContent = 'HTTP Compatibility Mode';
		left.appendChild(label);
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'HTTP/2 provides low-latency streaming. Switch to HTTP/1.1 if your proxy or firewall does not support HTTP/2.';
		left.appendChild(desc);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		const dropdown = createCustomDropdown(['HTTP/2', 'HTTP/1.1'], 'HTTP/2', (newValue) => {
			if (this._invoke) {
				this._invoke('settings_update', { key: 'sidex.network.httpMode', value: JSON.stringify(newValue), scope: 'user' }).catch(() => {});
			}
		});

		if (this._invoke) {
			this._invoke('settings_get', { section: 'sidex.network.httpMode' }).then((val) => {
				if (val && typeof val === 'string') { (dropdown as any).setValue(val); }
			}).catch(() => {});
		}

		action.appendChild(dropdown);
		row.appendChild(action);
		card.appendChild(row);
		container.appendChild(card);
	}

	private _renderRequiredDomains(container: HTMLElement): void {
		const domains = [...this._providerDomains, ...FIXED_DOMAINS];

		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.marginTop = '12px';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.style.fontWeight = '600';
		label.textContent = 'Required Domains';
		left.appendChild(label);
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'These domains must be accessible for SideX to function: your configured AI provider(s), the extension marketplace, and update checks. Add them to your firewall or proxy allowlist.';
		left.appendChild(desc);
		const note = document.createElement('div');
		note.className = 'sidex-settings-row-description';
		note.textContent = 'The agent server itself runs on loopback (127.0.0.1) and never leaves this machine, so it does not need a firewall entry.';
		left.appendChild(note);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		action.style.cssText = 'display:flex;gap:8px;';

		const copyBtn = document.createElement('button');
		copyBtn.className = 'sidex-settings-btn';
		copyBtn.textContent = 'Copy Domains';
		copyBtn.addEventListener('click', () => {
			const domainList = domains.join('\n');
			if (this._invoke) {
				this._invoke('clipboard_write_text', { text: domainList }).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy Domains'; }, 2000);
				}).catch(() => {
					navigator.clipboard.writeText(domainList).then(() => {
						copyBtn.textContent = 'Copied!';
						setTimeout(() => { copyBtn.textContent = 'Copy Domains'; }, 2000);
					}).catch(() => {});
				});
			} else {
				navigator.clipboard.writeText(domainList).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy Domains'; }, 2000);
				}).catch(() => {});
			}
		});
		action.appendChild(copyBtn);

		const showBtn = document.createElement('button');
		showBtn.className = 'sidex-settings-btn';
		showBtn.textContent = 'Show';
		showBtn.addEventListener('click', () => {
			this._domainsVisible = !this._domainsVisible;
			showBtn.textContent = this._domainsVisible ? 'Hide' : 'Show';
			domainsList.style.display = this._domainsVisible ? 'block' : 'none';
		});
		action.appendChild(showBtn);

		row.appendChild(action);
		card.appendChild(row);

		const domainsList = document.createElement('div');
		domainsList.style.cssText = 'display:none;padding:0 16px 12px;';

		const domainsPre = document.createElement('div');
		domainsPre.style.cssText = 'font-family:var(--vscode-editor-font-family, monospace);font-size:11px;color:var(--vscode-settings-textInputForeground);background:var(--vscode-settings-textInputBackground);border:1px solid var(--vscode-settings-textInputBorder, transparent);border-radius:2px;padding:8px 12px;line-height:1.6;';
		domainsPre.textContent = domains.join('\n');
		domainsList.appendChild(domainsPre);

		card.appendChild(domainsList);
		container.appendChild(card);
	}

	private _renderDiagnostics(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.marginTop = '12px';

		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const label = document.createElement('div');
		label.className = 'sidex-settings-row-label';
		label.textContent = 'Network Diagnostics';
		left.appendChild(label);
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.textContent = 'Check connectivity to the local agent server and to the domains above.';
		left.appendChild(desc);
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		const runBtn = document.createElement('button');
		runBtn.className = 'sidex-settings-btn sidex-settings-btn-primary';
		runBtn.textContent = 'Run Diagnostic';
		runBtn.addEventListener('click', () => {
			this._runDiagnostic(runBtn, card);
		});
		action.appendChild(runBtn);
		row.appendChild(action);

		card.appendChild(row);
		container.appendChild(card);
	}

	private async _runDiagnostic(btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
		btn.disabled = true;
		btn.textContent = 'Running...';

		const prev = card.querySelector('.sidex-settings-diag-results');
		if (prev) { prev.remove(); }

		const results: { domain: string; ok: boolean; latencyMs?: number }[] = [];

		const testDomain = async (domain: string): Promise<{ domain: string; ok: boolean; latencyMs?: number }> => {
			const start = performance.now();
			try {
				await fetch(`https://${domain}`, { method: 'HEAD', mode: 'no-cors', signal: AbortSignal.timeout(5000) });
				const latencyMs = Math.round(performance.now() - start);
				return { domain, ok: true, latencyMs };
			} catch {
				const latencyMs = Math.round(performance.now() - start);
				return { domain, ok: false, latencyMs: latencyMs < 5000 ? latencyMs : undefined };
			}
		};

		// The agent server is loopback-only, so it gets its own check against
		// the port Rust actually bound rather than a DNS name like the rest.
		const testLocalServer = async (): Promise<{ domain: string; ok: boolean; latencyMs?: number }> => {
			const start = performance.now();
			try {
				const endpoint = await resolveServerEndpoint();
				if (!endpoint.running) {
					return { domain: 'Local agent server (loopback)', ok: false };
				}
				await fetch(`${endpoint.httpUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
				const latencyMs = Math.round(performance.now() - start);
				return { domain: 'Local agent server (loopback)', ok: true, latencyMs };
			} catch {
				return { domain: 'Local agent server (loopback)', ok: false };
			}
		};

		const domains = [...this._providerDomains, ...FIXED_DOMAINS];
		const [localResult, ...domainResults] = await Promise.all([testLocalServer(), ...domains.map(d => testDomain(d))]);
		results.push(localResult, ...domainResults);

		const resultsEl = document.createElement('div');
		resultsEl.className = 'sidex-settings-diag-results';
		resultsEl.style.cssText = 'padding:8px 16px 12px;';

		for (const r of results) {
			const line = document.createElement('div');
			line.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;padding:2px 0;';

			const icon = document.createElement('span');
			icon.className = r.ok ? 'codicon codicon-check' : 'codicon codicon-error';
			icon.style.color = r.ok ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-testing-iconFailed)';
			line.appendChild(icon);

			const domain = document.createElement('span');
			domain.style.cssText = 'font-family:var(--vscode-editor-font-family, monospace);color:var(--vscode-editor-foreground);';
			domain.textContent = r.domain;
			line.appendChild(domain);

			if (r.latencyMs !== undefined) {
				const latency = document.createElement('span');
				latency.style.cssText = 'color:var(--vscode-descriptionForeground);margin-left:auto;';
				latency.textContent = `${r.latencyMs}ms`;
				line.appendChild(latency);
			}

			resultsEl.appendChild(line);
		}

		card.appendChild(resultsEl);
		btn.disabled = false;
		btn.textContent = 'Run Diagnostic';
	}

	dispose(): void {
		this._container = null;
	}
}
