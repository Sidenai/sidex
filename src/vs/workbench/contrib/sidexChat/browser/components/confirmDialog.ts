/*---------------------------------------------------------------------------------------------
 *  Confirm Dialog — reusable modal confirmation over a dimming overlay.
 *  Used wherever an action needs an explicit "are you sure" step (e.g.
 *  connecting an AI provider account) instead of firing instantly.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from './base.js';
import { Emitter, Event } from '../../../../../base/common/event.js';

export interface IConfirmDialogOptions {
	title: string;
	/** Body text. Rendered as paragraphs, one per array entry. */
	body: string[];
	/** Optional emphasised caution line, rendered distinctly. */
	caution?: string;
	confirmLabel: string;
	cancelLabel?: string;
	/** Renders the confirm button in a destructive/warning style. */
	danger?: boolean;
}

let _idSeq = 0;

/** A single-use overlay: build, resolve once, tear down. Not meant to be reparented or reused. */
export class ConfirmDialog extends Component {
	private readonly _onClose = this._register(new Emitter<boolean>());
	readonly onClose: Event<boolean> = this._onClose.event;

	private readonly _dialog: HTMLElement;
	private readonly _confirmBtn: HTMLButtonElement;
	private readonly _previouslyFocused: HTMLElement | null;
	private _closed = false;

	constructor(options: IConfirmDialogOptions) {
		super('div', 'sc-confirm-overlay');
		ensureConfirmDialogStyles();

		// Captured now, not at close time — by then activeElement is our own button.
		this._previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const titleId = `sc-confirm-title-${++_idSeq}`;

		this._dialog = this.append('div', 'sc-confirm-dialog');
		this._dialog.setAttribute('role', 'dialog');
		this._dialog.setAttribute('aria-modal', 'true');
		this._dialog.setAttribute('aria-labelledby', titleId);

		const title = DOM.append(this._dialog, $('div.sc-confirm-title'));
		title.id = titleId;
		title.textContent = options.title;

		const body = DOM.append(this._dialog, $('div.sc-confirm-body'));
		for (const line of options.body) {
			const p = DOM.append(body, $('p.sc-confirm-paragraph'));
			p.textContent = line;
		}

		if (options.caution) {
			const caution = DOM.append(this._dialog, $('div.sc-confirm-caution'));
			const icon = DOM.append(caution, $('span.codicon.codicon-warning'));
			icon.setAttribute('aria-hidden', 'true');
			const text = DOM.append(caution, $('span.sc-confirm-caution-text'));
			text.textContent = options.caution;
		}

		const buttons = DOM.append(this._dialog, $('div.sc-confirm-buttons'));

		const cancelBtn = DOM.append(buttons, $('button.sc-confirm-btn.sc-confirm-cancel')) as HTMLButtonElement;
		cancelBtn.type = 'button';
		cancelBtn.textContent = options.cancelLabel ?? 'Cancel';
		this.on(cancelBtn, 'click', () => this._close(false));

		const confirmBtn = DOM.append(buttons, $('button.sc-confirm-btn.sc-confirm-confirm')) as HTMLButtonElement;
		confirmBtn.type = 'button';
		confirmBtn.textContent = options.confirmLabel;
		if (options.danger) {
			confirmBtn.classList.add('sc-confirm-danger');
		}
		this.on(confirmBtn, 'click', () => this._close(true));
		this._confirmBtn = confirmBtn;

		// Overlay click dismisses like a Cancel — but only the backdrop itself, not the dialog body.
		this.on(this.element, 'click', (e) => {
			if (e.target === this.element) {
				this._close(false);
			}
		});

		this.on(this.element, 'keydown', (e) => {
			const ke = e as KeyboardEvent;
			if (ke.key === 'Escape') {
				ke.preventDefault();
				this._close(false);
				return;
			}
			if (ke.key === 'Tab') {
				this._trapTab(ke);
			}
		});
	}

	/** Focuses the confirm button; call once the element is attached so focus() actually takes. */
	focusDefault(): void {
		this._confirmBtn.focus();
	}

	private _focusableElements(): HTMLElement[] {
		return Array.from(this._dialog.querySelectorAll<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		)).filter(el => !el.hasAttribute('disabled'));
	}

	private _trapTab(e: KeyboardEvent): void {
		const focusable = this._focusableElements();
		if (focusable.length === 0) {
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		const withinDialog = active instanceof HTMLElement && this._dialog.contains(active);

		if (e.shiftKey) {
			if (!withinDialog || active === first) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (!withinDialog || active === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	private _close(result: boolean): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._onClose.fire(result);
		this._previouslyFocused?.focus();
		this.element.remove();
		this.dispose();
	}
}

/** Resolves true when confirmed, false when cancelled or dismissed. */
export function showConfirmDialog(options: IConfirmDialogOptions): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const dialog = new ConfirmDialog(options);
		const subscription = dialog.onClose(result => {
			subscription.dispose();
			resolve(result);
		});
		// Theme color tokens live on `.monaco-workbench`, not on `body`.
		// Mounting on body leaves `--vscode-editorWidget-background` unset, so
		// the card paints transparent and settings text shows through.
		const host = document.querySelector('.monaco-workbench') ?? document.body;
		dialog.appendTo(host);
		// Deferred a frame so the element has layout before it (or anything in it) can take focus.
		requestAnimationFrame(() => dialog.focusDefault());
	});
}

let _styleElement: HTMLStyleElement | null = null;

function ensureConfirmDialogStyles(): void {
	if (_styleElement) {
		return;
	}
	_styleElement = document.createElement('style');
	_styleElement.id = 'sidex-confirm-dialog-styles';
	_styleElement.textContent = CONFIRM_DIALOG_CSS;
	document.head.appendChild(_styleElement);
}

const CONFIRM_DIALOG_CSS = `
.sc-confirm-overlay {
	position: fixed;
	inset: 0;
	/* Scrim has no themed variable in VS Code — same rgba(0,0,0,…) idiom the
	   settings modal overlay uses; everything else below is var()-only. */
	background: rgba(0, 0, 0, 0.4);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
	animation: sc-confirm-fade-in 0.12s ease-out;
}

.sc-confirm-dialog {
	/* Widget token is often translucent; editor/sidebar backgrounds are opaque.
	   Hard fallback matches the settings modal so this stays solid if tokens
	   still fail to inherit. */
	background: var(--vscode-sideBar-background, var(--vscode-editor-background, #141414));
	color: var(--vscode-foreground);
	border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
	border-radius: 8px;
	padding: 16px;
	width: 360px;
	max-width: calc(100vw - 32px);
	max-height: calc(100vh - 32px);
	overflow-y: auto;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
	animation: sc-confirm-scale-in 0.12s ease-out;
}

.sc-confirm-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--vscode-foreground);
	margin-bottom: 8px;
}

.sc-confirm-body {
	margin-bottom: 8px;
}

.sc-confirm-paragraph {
	font-size: 12px;
	line-height: 1.5;
	color: var(--vscode-foreground);
	margin: 0 0 8px;
}

.sc-confirm-paragraph:last-child {
	margin-bottom: 0;
}

.sc-confirm-caution {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	padding: 8px 10px;
	margin: 4px 0 12px;
	border-radius: 4px;
	border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
	background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.08));
}

.sc-confirm-caution .codicon {
	color: var(--vscode-editorWarning-foreground);
	font-size: 14px;
	margin-top: 1px;
}

.sc-confirm-caution-text {
	font-size: 12px;
	line-height: 1.4;
	color: var(--vscode-foreground);
}

.sc-confirm-buttons {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 4px;
}

.sc-confirm-btn {
	padding: 6px 14px;
	border-radius: 4px;
	font-size: 12px;
	font-family: var(--vscode-font-family);
	cursor: pointer;
	border: 1px solid transparent;
	transition: background 0.1s ease;
}

.sc-confirm-cancel {
	background: transparent;
	color: var(--vscode-foreground);
	border-color: var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
}

.sc-confirm-cancel:hover {
	background: var(--vscode-list-hoverBackground);
}

.sc-confirm-confirm {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}

.sc-confirm-confirm:hover {
	background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
}

.sc-confirm-confirm.sc-confirm-danger {
	background: var(--vscode-statusBarItem-errorBackground, var(--vscode-errorForeground));
}

.sc-confirm-confirm.sc-confirm-danger:hover {
	background: var(--vscode-statusBarItem-errorHoverBackground, var(--vscode-errorForeground));
}

.sc-confirm-btn:focus {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}

@keyframes sc-confirm-fade-in {
	from { opacity: 0; }
	to { opacity: 1; }
}

@keyframes sc-confirm-scale-in {
	from { opacity: 0; transform: scale(0.96) translateY(4px); }
	to { opacity: 1; transform: scale(1) translateY(0); }
}
`;
