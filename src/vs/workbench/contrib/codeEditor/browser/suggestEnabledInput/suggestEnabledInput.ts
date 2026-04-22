/*---------------------------------------------------------------------------------------------
 *  SideX - A fast, native code editor
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *--------------------------------------------------------------------------------------------*/

import { Widget } from '../../../../../base/browser/ui/widget.js';
import { Event, Emitter } from '../../../../../base/common/event.js';

export interface ISuggestResultsProvider {
	provideResults(value: string): string[];
}

export const SuggestResultsProvider = Symbol('SuggestResultsProvider');

const INPUT_STYLES = [
	'flex:1',
	'min-width:0',
	'height:22px',
	'background:transparent',
	'color:inherit',
	'border:none',
	'outline:none',
	'padding:0 2px',
	'font-family:var(--vscode-font-family,inherit)',
	'font-size:var(--vscode-font-size,13px)'
].join(';');

const WRAPPER_STYLES = [
	'display:flex',
	'align-items:center',
	'width:100%',
	'box-sizing:border-box',
	'height:24px',
	'line-height:24px',
	'padding:0 4px',
	'background-color:var(--vscode-input-background)',
	'color:var(--vscode-input-foreground)',
	'border:1px solid var(--vscode-input-border,transparent)',
	'border-radius:2px'
].join(';');

function extractOptions(args: unknown[]): {
	parent: HTMLElement | undefined;
	placeholder?: string;
	ariaLabel?: string;
} {
	let parent: HTMLElement | undefined;
	let placeholder: string | undefined;
	let ariaLabel: string | undefined;

	for (const arg of args) {
		if (!parent && arg instanceof HTMLElement) {
			parent = arg;
			continue;
		}
		if (arg && typeof arg === 'object') {
			const opts = arg as Record<string, unknown>;
			if (typeof opts.placeholderText === 'string') {
				placeholder = opts.placeholderText;
			}
			if (typeof opts.ariaLabel === 'string') {
				ariaLabel = opts.ariaLabel;
			}
		} else if (typeof arg === 'string' && arg.length > 3 && arg.length < 200 && arg.includes(' ') && !ariaLabel) {
			ariaLabel = arg;
		}
	}

	return { parent, placeholder, ariaLabel };
}

export class SuggestEnabledInput extends Widget {
	private readonly _onShouldFocusResults = this._register(new Emitter<void>());
	readonly onShouldFocusResults: Event<void> = this._onShouldFocusResults.event;

	private readonly _onInputDidChange = this._register(new Emitter<string | undefined>());
	readonly onInputDidChange: Event<string | undefined> = this._onInputDidChange.event;

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus: Event<void> = this._onDidFocus.event;

	private readonly _onDidBlur = this._register(new Emitter<void>());
	readonly onDidBlur: Event<void> = this._onDidBlur.event;

	protected readonly element: HTMLDivElement;
	protected readonly inputElement: HTMLInputElement;

	constructor(...args: unknown[]) {
		super();

		const { parent, placeholder, ariaLabel } = extractOptions(args);

		this.element = document.createElement('div');
		this.element.className = 'suggest-input-container monaco-inputbox idle';
		this.element.setAttribute('style', WRAPPER_STYLES);

		this.inputElement = document.createElement('input');
		this.inputElement.type = 'text';
		this.inputElement.className = 'suggest-input-input';
		this.inputElement.setAttribute('style', INPUT_STYLES);

		if (placeholder) {
			this.inputElement.placeholder = placeholder;
		}
		if (ariaLabel) {
			this.inputElement.setAttribute('aria-label', ariaLabel);
		}

		this.inputElement.addEventListener('input', () => this._onInputDidChange.fire(this.inputElement.value));
		this.inputElement.addEventListener('focus', () => this._onDidFocus.fire());
		this.inputElement.addEventListener('blur', () => this._onDidBlur.fire());
		this.inputElement.addEventListener('keydown', e => {
			if (e.key === 'Enter' || e.key === 'ArrowDown') {
				this._onShouldFocusResults.fire();
			}
		});

		this.element.appendChild(this.inputElement);
		parent?.appendChild(this.element);
	}

	getValue(): string {
		return this.inputElement.value;
	}

	setValue(value: string): void {
		this.inputElement.value = value;
		this._onInputDidChange.fire(value);
	}

	override focus(): void {
		this.inputElement.focus();
	}

	layout(_dimension?: { width?: number; height?: number }): void {
		// Layout driven by parent flex rules.
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	setEnabled(enabled: boolean): void {
		this.inputElement.disabled = !enabled;
	}

	setPlaceHolder(text: string): void {
		this.inputElement.placeholder = text;
	}

	hasFocus(): boolean {
		return document.activeElement === this.inputElement;
	}

	get inputWidget(): { hasWidgetFocus(): boolean; focus(): void } {
		return {
			hasWidgetFocus: () => this.hasFocus(),
			focus: () => this.focus()
		};
	}

	onHide(): void {
		// no-op — SideX uses a plain <input>, not a CodeEditorWidget
	}

	get onFocus(): Event<void> {
		return this._onDidFocus.event;
	}
}

export class SuggestEnabledInputWithHistory extends SuggestEnabledInput {
	private readonly _history: string[] = [];
	private _historyIndex = -1;

	constructor(...args: unknown[]) {
		super(...args);

		this.inputElement.addEventListener('keydown', e => {
			if (e.key === 'ArrowUp' && this._history.length > 0) {
				e.preventDefault();
				this._step(1);
			} else if (e.key === 'ArrowDown' && this._historyIndex > 0) {
				e.preventDefault();
				this._step(-1);
			}
		});
	}

	addToHistory(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) {
			return;
		}
		if (this._history[this._history.length - 1] === trimmed) {
			return;
		}
		this._history.push(trimmed);
		this._historyIndex = -1;
	}

	showNextValue(): void {
		this._step(-1);
	}

	showPreviousValue(): void {
		this._step(1);
	}

	private _step(delta: 1 | -1): void {
		if (this._history.length === 0) {
			return;
		}
		this._historyIndex = Math.max(0, Math.min(this._historyIndex + delta, this._history.length - 1));
		const value = this._history[this._history.length - 1 - this._historyIndex] ?? '';
		this.setValue(value);
	}
}

export class ContextScopedSuggestEnabledInputWithHistory extends SuggestEnabledInputWithHistory {
	constructor(...args: unknown[]) {
		super(...args);
	}
}
