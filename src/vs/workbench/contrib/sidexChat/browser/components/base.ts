/*---------------------------------------------------------------------------------------------
 *  Base component class for Sidex Chat UI components.
 *  Lightweight DOM component system — no React, no framework.
 *  Each component owns its root element, manages its children, and
 *  cleans up via Disposable.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';

const $ = DOM.$;
export { $, DOM };

export abstract class Component extends Disposable {
	readonly element: HTMLElement;
	protected readonly _disposables = this._register(new DisposableStore());

	constructor(tag: string, ...classNames: string[]) {
		super();
		this.element = document.createElement(tag);
		if (classNames.length > 0) {
			this.element.classList.add(...classNames);
		}
	}

	appendTo(parent: HTMLElement): this {
		parent.appendChild(this.element);
		return this;
	}

	// Accepts (and ignores) arguments so subclasses can declare richer
	// show(...) signatures (e.g. MentionPopup.show(items, anchorRect)).
	show(..._args: unknown[]): void { this.element.style.display = ''; }
	hide(): void { this.element.style.display = 'none'; }

	toggleClass(cls: string, force?: boolean): void {
		this.element.classList.toggle(cls, force);
	}

	protected on(el: HTMLElement, event: string, handler: (e: globalThis.Event) => void): void {
		this._disposables.add(DOM.addDisposableListener(el, event, handler as EventListener));
	}

	protected append(tag: string, ...classNames: string[]): HTMLElement {
		return DOM.append(this.element, $(tag + classNames.map(c => '.' + c).join('')));
	}

	protected appendText(tag: string, text: string, ...classNames: string[]): HTMLElement {
		const el = this.append(tag, ...classNames);
		el.textContent = text;
		return el;
	}

	protected clear(): void {
		DOM.clearNode(this.element);
	}
}

export abstract class ClickableComponent extends Component {
	private readonly _onClick = this._register(new Emitter<MouseEvent>());
	readonly onClick: Event<MouseEvent> = this._onClick.event;

	constructor(tag: string, ...classNames: string[]) {
		super(tag, ...classNames);
		this.on(this.element, 'click', (e) => this._onClick.fire(e as MouseEvent));
	}
}

/** Format a timestamp as "10:24 AM" */
export function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = d.getHours();
	const m = d.getMinutes().toString().padStart(2, '0');
	const ampm = h >= 12 ? 'PM' : 'AM';
	const h12 = h % 12 || 12;
	return `${h12}:${m} ${ampm}`;
}

/** Format duration as "13s" or "2m 15s" */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) { return `${s}s`; }
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Format token count as "12.4k" */
export function formatTokens(n: number): string {
	if (n < 1000) { return String(n); }
	return (n / 1000).toFixed(1) + 'k';
}

/** Format cost as "$0.0234" */
export function formatCost(n: number): string {
	return '$' + n.toFixed(4);
}

/** Escape HTML for safe rendering */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
