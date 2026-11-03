import { Component, $, DOM, escapeHtml } from '../base.js';

export class ThinkingBlock extends Component {
	private readonly _headerEl: HTMLElement;
	private readonly _contentEl: HTMLElement;
	private readonly _indicatorEl: HTMLElement;
	private readonly _elapsedEl: HTMLElement;
	private readonly _chevronEl: HTMLElement;
	private _expanded = false;
	private _streaming = false;
	private _startTime = Date.now();
	private _timerHandle: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super('div', 'ui-collapsible');
		this.element.classList.add('ui-thinking-collapsible');
		this.element.dataset.open = 'false';
		this.element.dataset.expandable = 'true';

		this._headerEl = this.append('div', 'ui-collapsible-header');
		this._headerEl.setAttribute('role', 'button');
		this._headerEl.setAttribute('aria-expanded', 'false');
		this._headerEl.tabIndex = 0;
		this._headerEl.style.cssText = 'cursor: pointer; opacity: 1; display: flex; align-items: center; gap: 6px; padding: 4px 0; margin-bottom: 6px;';
		const action = DOM.append(this._headerEl, $('span.ui-collapsible-action'));
		action.style.cssText = 'font-weight: 400; color: var(--vscode-descriptionForeground); flex-shrink: 0;';
		action.textContent = 'Thought';

		this._elapsedEl = DOM.append(this._headerEl, $('span.ui-collapsible-details'));
		this._elapsedEl.style.cssText = 'color: var(--vscode-descriptionForeground); opacity: 0.6; overflow: hidden; text-overflow: ellipsis;';
		this._elapsedEl.textContent = 'for 0s';

		this._chevronEl = document.createElement('i');
		this._chevronEl.className = 'cursor-icon ui-icon ui-collapsible-chevron';
		this._chevronEl.setAttribute('data-icon-name', 'chevron-right');
		this._chevronEl.setAttribute('aria-hidden', 'true');
		this._chevronEl.style.cssText = '--cursor-icon-content: ""; --icon-size: 10px; transition: transform 0.15s ease; margin-left: 4px;';
		this._headerEl.appendChild(this._chevronEl);

		this._indicatorEl = document.createElement('span');

		this._contentEl = this.append('div', 'sc-thinking-content');
		this._contentEl.style.cssText = 'display: none; padding: 8px 12px; margin-bottom: 8px; border-left: 2px solid var(--vscode-widget-border, rgba(255,255,255,0.1)); font-size: 12px; color: var(--vscode-descriptionForeground); opacity: 0.8; font-family: monospace; white-space: pre-wrap; word-break: break-all;';

		this.on(this._headerEl, 'click', () => this._toggle());
	}

	startStreaming(): void {
		this._streaming = true;
		this._startTime = Date.now();
		this.element.classList.add('streaming');
		this._timerHandle = setInterval(() => this._updateElapsed(), 1000);
		this._updateElapsed();
	}

	appendContent(text: string): void {
		const escaped = escapeHtml(text);
		this._contentEl.innerHTML += escaped.replace(/\n/g, '<br>');

		if (this._expanded) {
			this._contentEl.scrollTop = this._contentEl.scrollHeight;
		}
	}

	stopStreaming(): void {
		this._streaming = false;
		this.element.classList.remove('streaming');
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		this._updateElapsed();
	}

	setFullContent(text: string): void {
		this._contentEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
	}

	private _toggle(): void {
		this._expanded = !this._expanded;
		this.element.dataset.open = String(this._expanded);
		this._chevronEl.style.transform = this._expanded ? 'rotate(90deg)' : 'rotate(0deg)';
		this._contentEl.style.display = this._expanded ? 'block' : 'none';
	}

	private _updateElapsed(): void {
		const elapsed = Math.round((Date.now() - this._startTime) / 1000);
		if (elapsed < 60) {
			this._elapsedEl.textContent = `for ${elapsed}s`;
		} else {
			const m = Math.floor(elapsed / 60);
			const s = elapsed % 60;
			this._elapsedEl.textContent = s > 0 ? `for ${m}m ${s}s` : `for ${m}m`;
		}
	}

	override dispose(): void {
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		super.dispose();
	}
}
