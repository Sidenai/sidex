/*---------------------------------------------------------------------------------------------
 *  MentionPopup — autocomplete dropdown for @ mentions in Sidex Chat
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import type { MentionItem } from '../../context/mentionResolver.js';

export class MentionPopup extends Component {
	private _listEl: HTMLElement;
	private _items: MentionItem[] = [];
	private _selectedIndex = 0;
	private _onSelect: (item: MentionItem) => void;
	private _visible = false;

	constructor(parent: HTMLElement, onSelect: (item: MentionItem) => void) {
		super('div', 'sc-mention-popup');
		this._onSelect = onSelect;
		this.element.style.display = 'none';

		this._listEl = DOM.append(this.element, $('div.sc-mention-list'));

		parent.appendChild(this.element);
	}

	get isVisible(): boolean { return this._visible; }

	show(items: MentionItem[], anchorRect: DOMRect): void {
		this._items = items;
		this._selectedIndex = 0;

		if (items.length === 0) {
			this.hide();
			return;
		}

		this._renderItems();
		this._positionAt(anchorRect);

		this.element.style.display = '';
		this._visible = true;
	}

	hide(): void {
		this.element.style.display = 'none';
		this._visible = false;
		this._items = [];
		this._selectedIndex = 0;
	}

	selectNext(): void {
		if (this._items.length === 0) { return; }
		this._selectedIndex = (this._selectedIndex + 1) % this._items.length;
		this._updateSelection();
	}

	selectPrevious(): void {
		if (this._items.length === 0) { return; }
		this._selectedIndex = (this._selectedIndex - 1 + this._items.length) % this._items.length;
		this._updateSelection();
	}

	confirmSelection(): void {
		if (this._items.length === 0) { return; }
		const item = this._items[this._selectedIndex];
		if (item) {
			this._onSelect(item);
		}
		this.hide();
	}

	private _positionAt(anchorRect: DOMRect): void {
		const parentRect = this.element.parentElement?.getBoundingClientRect();
		if (!parentRect) { return; }

		this.element.style.left = `${anchorRect.left - parentRect.left}px`;
		this.element.style.bottom = `${parentRect.bottom - anchorRect.top + 4}px`;
	}

	private _renderItems(): void {
		DOM.clearNode(this._listEl);

		this._items.forEach((item, i) => {
			const row = DOM.append(this._listEl, $('div.sc-mention-item'));
			if (i === this._selectedIndex) {
				row.classList.add('selected');
			}

			const icon = DOM.append(row, $('span.sc-mention-item-icon'));
			if (item.iconClass) {
				icon.classList.add(...item.iconClass.split(' '));
			} else {
				icon.classList.add(item.type === 'folder' ? 'codicon-folder' : 'codicon-file');
			}

			const textWrap = DOM.append(row, $('div.sc-mention-item-text'));
			const label = DOM.append(textWrap, $('span.sc-mention-item-label'));
			label.textContent = item.label;

			if (item.detail) {
				const detail = DOM.append(textWrap, $('span.sc-mention-item-detail'));
				detail.textContent = item.detail;
			}

			row.addEventListener('mouseenter', () => {
				this._selectedIndex = i;
				this._updateSelection();
			});

			row.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._onSelect(item);
				this.hide();
			});
		});
	}

	private _updateSelection(): void {
		const rows = this._listEl.querySelectorAll('.sc-mention-item');
		rows.forEach((row, i) => {
			(row as HTMLElement).classList.toggle('selected', i === this._selectedIndex);
		});

		const selected = rows[this._selectedIndex] as HTMLElement | undefined;
		if (selected) {
			selected.scrollIntoView({ block: 'nearest' });
		}
	}
}
