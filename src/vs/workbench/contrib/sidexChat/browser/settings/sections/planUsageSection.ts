/*---------------------------------------------------------------------------------------------
 *  Usage section — local token/spend plus live Claude Code / Codex plan windows.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createProductMark, productMarkKind } from '../productMarks.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface UsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: string;
}

interface ExtraCredits {
	enabled: boolean;
	used: number;
	limit: number;
	usedPercent: number;
	balance?: string;
	currency?: string;
	creditsRemaining?: number;
	usdRemaining?: number;
}

interface UsageAccount {
	id: string;
	label: string;
	source: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	windows?: UsageWindow[];
	extraCredits?: ExtraCredits | null;
	unavailable?: string;
}

interface TauriUsage {
	totalCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	periodStart: string;
	periodEnd: string;
	accounts?: UsageAccount[];
}

export class PlanUsageSection implements SettingsSection {
	constructor(private readonly _invoke: TauriInvoke) {}

	async render(container: HTMLElement): Promise<void> {
		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title no-border';
		title.textContent = 'Usage';
		container.appendChild(title);

		if (!this._invoke) {
			this._renderError(container, 'Tauri not available.');
			return;
		}

		const loading = document.createElement('div');
		loading.style.cssText = 'font-size:12px;padding:8px 24px;color:var(--vscode-descriptionForeground);';
		loading.textContent = 'Loading…';
		container.appendChild(loading);

		let usage: TauriUsage | null = null;
		try {
			usage = await this._invoke('auth_get_usage') as TauriUsage;
		} catch { /* local server may not be up yet */ }

		loading.remove();

		if (!usage) {
			this._renderError(container, 'Usage data is unavailable.');
			return;
		}

		const accounts = Array.isArray(usage.accounts) ? usage.accounts : [];
		if (accounts.length === 0) {
			this._renderTotals(container, usage);
			this._renderFooter(container);
			return;
		}

		for (const account of accounts) {
			this._renderAccount(container, account);
		}
		this._renderTotals(container, usage);
		this._renderFooter(container);
	}

	private _renderAccount(container: HTMLElement, account: UsageAccount): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.marginBottom = '12px';
		container.appendChild(card);

		const head = document.createElement('div');
		head.className = 'sidex-settings-row';
		const titleWrap = document.createElement('div');
		titleWrap.style.minWidth = '0';
		const titleRow = document.createElement('div');
		titleRow.className = 'sidex-product-label-row';
		const markKind = productMarkKind(account.id) ?? productMarkKind(account.label);
		if (markKind) {
			titleRow.appendChild(createProductMark(markKind));
		}
		const title = document.createElement('div');
		title.className = 'sidex-settings-row-label';
		title.textContent = account.label;
		titleRow.appendChild(title);
		titleWrap.appendChild(titleRow);
		const sub = document.createElement('div');
		sub.className = 'sidex-settings-row-description';
		sub.textContent = sourceLabel(account.source);
		titleWrap.appendChild(sub);
		head.appendChild(titleWrap);
		card.appendChild(head);

		const windows = (account.windows ?? []).map(window => {
			if (!isCodexAccount(account) || !/week/i.test(`${window.id} ${window.label}`)) {
				return window;
			}
			return { ...window, id: 'monthly', label: 'Monthly' };
		});
		if (windows.length === 0 && !account.extraCredits && !account.unavailable) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-row-description';
			empty.style.padding = '0 16px 12px';
			empty.textContent = account.source === 'oauth'
				? 'Plan limits will show here after this account answers a usage request.'
				: 'API keys have no 5-hour or weekly session cap — spend below is what SideX recorded.';
			card.appendChild(empty);
		}

		for (const window of windows) {
			card.appendChild(meterRow(
				window.label,
				window.usedPercent,
				formatReset(window.resetsAt)
			));
		}

		if (account.extraCredits) {
			const extra = account.extraCredits;
			const usd = extraUsdRemaining(extra);
			if (usd != null && extra.limit === 0) {
				const credits = extra.creditsRemaining ?? parseCreditBalance(extra.balance);
				const detail = credits != null && credits > 0
					? `${credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
					: '';
				card.appendChild(moneyRow('Extra usage', formatUSD(usd), detail));
			} else {
				card.appendChild(meterRow('Extra usage', extra.usedPercent, extraCreditDetail(extra)));
			}
		}

		if (account.unavailable) {
			const note = document.createElement('div');
			note.className = 'sidex-settings-row-description';
			note.style.padding = '0 16px 12px';
			note.textContent = account.unavailable;
			card.appendChild(note);
		}

		const tokensRow = document.createElement('div');
		tokensRow.className = 'sidex-settings-row';
		const tokensLeft = document.createElement('div');
		const tokensLabel = document.createElement('div');
		tokensLabel.className = 'sidex-settings-row-label';
		tokensLabel.textContent = 'Tokens in SideX';
		tokensLeft.appendChild(tokensLabel);
		const tokensDesc = document.createElement('div');
		tokensDesc.className = 'sidex-settings-row-description';
		tokensDesc.textContent = `${Number(account.inputTokens || 0).toLocaleString()} in / ${Number(account.outputTokens || 0).toLocaleString()} out · ${formatUSD(account.cost || 0)}`;
		tokensLeft.appendChild(tokensDesc);
		tokensRow.appendChild(tokensLeft);
		card.appendChild(tokensRow);
	}

	private _renderTotals(container: HTMLElement, usage: TauriUsage): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		container.appendChild(card);

		const tokensRow = document.createElement('div');
		tokensRow.className = 'sidex-settings-row';

		const tokensLeft = document.createElement('div');
		const tokensLabel = document.createElement('div');
		tokensLabel.className = 'sidex-settings-row-label';
		tokensLabel.textContent = 'All providers';
		tokensLeft.appendChild(tokensLabel);

		const tokensDesc = document.createElement('div');
		tokensDesc.className = 'sidex-settings-row-description';
		tokensDesc.textContent = `${Number(usage.totalInputTokens || 0).toLocaleString()} in / ${Number(usage.totalOutputTokens || 0).toLocaleString()} out`;
		tokensLeft.appendChild(tokensDesc);
		tokensRow.appendChild(tokensLeft);

		const tokensVal = document.createElement('div');
		tokensVal.className = 'sidex-settings-row-label';
		tokensVal.style.fontWeight = '600';
		tokensVal.textContent = formatUSD(usage.totalCost ?? 0);
		tokensRow.appendChild(tokensVal);
		card.appendChild(tokensRow);
	}

	private _renderFooter(container: HTMLElement): void {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		container.appendChild(card);

		const actionRow = document.createElement('div');
		actionRow.className = 'sidex-settings-row';

		const actionDesc = document.createElement('div');
		actionDesc.className = 'sidex-settings-row-description';
		actionDesc.style.cssText = 'min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
		actionDesc.textContent = 'Session bars come from the connected Claude Code or Codex account.';
		actionRow.appendChild(actionDesc);

		const configureBtn = document.createElement('button');
		configureBtn.className = 'sidex-settings-btn';
		configureBtn.style.whiteSpace = 'nowrap';
		configureBtn.style.flexShrink = '0';
		configureBtn.textContent = 'Configure Providers';
		configureBtn.addEventListener('click', () => {
			window.dispatchEvent(new CustomEvent('sidex-settings-navigate', { detail: 'models' }));
		});
		actionRow.appendChild(configureBtn);
		card.appendChild(actionRow);
	}

	private _renderError(container: HTMLElement, msg: string): void {
		const el = document.createElement('div');
		el.style.cssText = 'font-size:12px;padding:8px 24px;color:var(--vscode-descriptionForeground);';
		el.textContent = msg;
		container.appendChild(el);
	}

	dispose(): void {}
}

function meterRow(label: string, usedPercent: number, detail: string): HTMLElement {
	const row = document.createElement('div');
	row.className = 'sidex-settings-row sidex-usage-meter sidex-usage-meter-oneline';

	const name = document.createElement('div');
	name.className = 'sidex-settings-row-label';
	name.textContent = label;
	row.appendChild(name);

	const clamped = clampPercent(usedPercent);
	const bar = document.createElement('div');
	bar.className = 'sidex-settings-progress sidex-usage-meter-bar-inline';
	const fill = document.createElement('div');
	fill.className = 'sidex-settings-progress-bar';
	fill.style.width = `${clamped}%`;
	if (clamped >= 90) {
		fill.style.background = 'var(--vscode-inputValidation-errorBorder, #f14c4c)';
	}
	bar.appendChild(fill);
	row.appendChild(bar);

	const pct = document.createElement('div');
	pct.className = 'sidex-settings-row-label';
	pct.style.cssText = 'font-weight:600;flex-shrink:0;white-space:nowrap;';
	pct.textContent = `${Math.round(clamped)}%`;
	row.appendChild(pct);

	if (detail) {
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.style.cssText = 'flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%;';
		desc.textContent = detail;
		row.appendChild(desc);
	}
	return row;
}

function moneyRow(label: string, amount: string, detail = ''): HTMLElement {
	const row = document.createElement('div');
	row.className = 'sidex-settings-row';
	const left = document.createElement('div');
	left.style.minWidth = '0';
	const name = document.createElement('div');
	name.className = 'sidex-settings-row-label';
	name.textContent = label;
	left.appendChild(name);
	if (detail) {
		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description';
		desc.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
		desc.textContent = detail;
		left.appendChild(desc);
	}
	row.appendChild(left);
	const val = document.createElement('div');
	val.className = 'sidex-settings-row-label';
	val.style.cssText = 'font-weight:600;white-space:nowrap;';
	val.textContent = amount;
	row.appendChild(val);
	return row;
}

const CODEX_CREDIT_USD = 0.04;

function extraUsdRemaining(extra: ExtraCredits): number | null {
	if (typeof extra.usdRemaining === 'number' && Number.isFinite(extra.usdRemaining) && extra.usdRemaining > 0) {
		return extra.usdRemaining;
	}
	const credits = extra.creditsRemaining ?? parseCreditBalance(extra.balance);
	if (credits != null && credits > 0) {
		return Math.floor(credits) * CODEX_CREDIT_USD;
	}
	return null;
}

function parseCreditBalance(raw?: string): number | null {
	if (!raw) {
		return null;
	}
	const n = Number(String(raw).replace(/,/g, ''));
	if (!Number.isFinite(n) || n <= 0) {
		return null;
	}
	return n;
}

function isCodexAccount(account: UsageAccount): boolean {
	return /codex|openai/i.test(`${account.id} ${account.label}`);
}

function clampPercent(n: number): number {
	if (!Number.isFinite(n) || n < 0) {
		return 0;
	}
	if (n > 100) {
		return 100;
	}
	return n;
}

function formatReset(iso?: string): string {
	if (!iso) {
		return '';
	}
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) {
		return '';
	}
	const when = new Date(t);
	const now = Date.now();
	if (t <= now) {
		return `Resets ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
	}
	const ms = t - now;
	const hours = Math.round(ms / 3_600_000);
	if (hours < 1) {
		const mins = Math.max(1, Math.round(ms / 60_000));
		return `Resets in ${mins} min`;
	}
	if (hours < 48) {
		return `Resets in ${hours}h · ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
	}
	return `Resets ${when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function extraCreditDetail(extra: ExtraCredits): string {
	const usd = extraUsdRemaining(extra);
	if (usd != null) {
		return `${formatUSD(usd)} remaining`;
	}
	if (extra.limit > 0) {
		return `${formatUSD(extra.used)} of ${formatUSD(extra.limit)}`;
	}
	if (!extra.enabled) {
		return 'Not enabled on this plan';
	}
	return extra.enabled ? 'Enabled' : '';
}

function sourceLabel(source: string): string {
	switch (source) {
		case 'oauth': return 'Connected account';
		case 'api_key': return 'API key';
		case 'local': return 'Local server';
		default: return 'Recorded in SideX';
	}
}

function formatUSD(n: number): string {
	if (!Number.isFinite(n) || n === 0) {
		return '$0.00';
	}
	return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
